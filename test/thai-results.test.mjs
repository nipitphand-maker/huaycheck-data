import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, unlinkSync } from 'node:fs';

import { chooseVerifiedResult, collectVerifiedResult, parseSanookPage, parseThairathPage, validateResult, writeIfNewer } from '../thai-results.mjs';

function numbers(start, count, width = 6) {
  return Array.from({ length: count }, (_, index) => String(start + index).padStart(width, '0'));
}

function completeResult(overrides = {}) {
  return {
    schemaVersion: 1,
    drawDate: '2026-07-16',
    publishedAt: '2026-07-16T10:00:00.000Z',
    source: 'verified-bot',
    firstPrize: '639214',
    adjacentToFirst: ['639213', '639215'],
    secondPrizes: numbers(200001, 5),
    thirdPrizes: numbers(300001, 10),
    fourthPrizes: numbers(400001, 50),
    fifthPrizes: numbers(500001, 100),
    frontThreeDigits: ['683', '709'],
    backThreeDigits: ['746', '427'],
    backTwoDigits: '71',
    sources: ['sanook'],
    ...overrides,
  };
}

function lotteryNumbers(numbers) {
  return numbers.map((number) => `<span class="lotto__number">${number}</span>`).join('');
}

function sanookPage(result, { includePrizes = true } = {}) {
  const [year, month, day] = result.drawDate.split('-');
  const slug = `${day}${month}${Number(year) + 543}`;
  const prizes = includePrizes ? `
    <span class="lotto__number lotto__number--first">${result.firstPrize}</span>
    เลขหน้า 3 ตัว ${lotteryNumbers(result.frontThreeDigits)}
    เลขท้าย 3 ตัว ${lotteryNumbers(result.backThreeDigits)}
    เลขท้าย 2 ตัว ${lotteryNumbers([result.backTwoDigits])}
    lottocheck__sec--nearby ${lotteryNumbers(result.adjacentToFirst)}
    รางวัลที่ 2 มี ${lotteryNumbers(result.secondPrizes)}
    รางวัลที่ 3 มี ${lotteryNumbers(result.thirdPrizes)}
    รางวัลที่ 4 มี ${lotteryNumbers(result.fourthPrizes)}
    รางวัลที่ 5 มี ${lotteryNumbers(result.fifthPrizes)}
  ` : '<span class="lotto__number lotto__number--first">639214</span>';
  return `<link rel="canonical" href="https://news.sanook.com/lotto/check/${slug}/"><main>${prizes}</main>`;
}

function thairathPage(result, overrides = {}) {
  const prizeData = {
    firstPrize: [result.firstPrize],
    secondPrizes: result.secondPrizes,
    thirdPrizes: result.thirdPrizes,
    fourthPrizes: result.fourthPrizes,
    fifthPrizes: result.fifthPrizes,
    backThreeDigits: result.backThreeDigits,
    backTwoDigits: [result.backTwoDigits],
    frontThreeDigits: result.frontThreeDigits,
    adjacentToFirst: result.adjacentToFirst,
    ...overrides,
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { initialState: {
      common: { data: { canonical: `https://www.thairath.co.th/lottery/check?date=${result.drawDate}` } },
      lottery: { data: { items: { dates: [{ str: result.drawDate }], prizes: {
        1: { data: prizeData.firstPrize }, 2: { data: prizeData.secondPrizes }, 3: { data: prizeData.thirdPrizes },
        4: { data: prizeData.fourthPrizes }, 5: { data: prizeData.fifthPrizes }, 6: { data: prizeData.backThreeDigits },
        7: { data: prizeData.backTwoDigits }, 10: { data: prizeData.frontThreeDigits }, 11: { data: prizeData.adjacentToFirst },
      } } } },
    } },
  })}</script>`;
}

function fetchBySource({ sanook, thairath }) {
  return (url) => url.includes('sanook') ? sanook() : thairath();
}

test('accepts a complete result with exact prize counts and digit widths', () => {
  assert.deepEqual(validateResult(completeResult()), { ok: true, value: completeResult() });
});

test('rejects a result with fewer than 100 fifth-prize numbers', () => {
  const result = completeResult({ fifthPrizes: numbers(500001, 99) });
  assert.equal(validateResult(result).ok, false);
});

test('rejects adjacent numbers that do not surround the first prize', () => {
  const result = completeResult({ adjacentToFirst: ['639212', '639215'] });
  assert.equal(validateResult(result).ok, false);
});

test('uses one complete source when the independent source is unavailable', () => {
  const result = chooseVerifiedResult([completeResult({ source: 'sanook' })], new Date('2026-07-16T10:00:00.000Z'));
  assert.equal(result.firstPrize, '639214');
  assert.deepEqual(result.sources, ['sanook']);
  assert.equal(result.source, 'verified-bot');
});

test('rejects complete sources with a first-prize mismatch', () => {
  assert.throws(
    () => chooseVerifiedResult([
      completeResult({ source: 'sanook' }),
      completeResult({ source: 'thairath', firstPrize: '111111', adjacentToFirst: ['111110', '111112'] }),
    ], new Date('2026-07-16T10:00:00.000Z')),
    /source result mismatch/,
  );
});

test('rejects complete sources with a fifth-prize mismatch', () => {
  const fifthPrizes = [...completeResult().fifthPrizes];
  fifthPrizes[0] = '999999';

  assert.throws(
    () => chooseVerifiedResult([
      completeResult({ source: 'sanook' }),
      completeResult({ source: 'thairath', fifthPrizes }),
    ], new Date('2026-07-16T10:00:00.000Z')),
    /source result mismatch/,
  );
});

test('reports no_draw when every source says the page is about another date', async () => {
  // The 2nd and the 17th are checked speculatively for a holiday-shifted draw.
  // In a month with no shift both sources correctly serve the previous draw,
  // and that used to surface as `parser error` — a red run every month for an
  // entirely normal condition, which is how a real breakage hides.
  const outcome = await collectVerifiedResult(
    '2026-09-02',
    fetchBySource({
      sanook: async () => '<html><head><link rel="canonical" href="https://news.sanook.com/lotto/check/01092569/"></head></html>',
      thairath: async () => thairathPage(completeResult({ drawDate: '2026-09-01' })),
    }),
    new Date('2026-09-02T10:00:00.000Z'),
  );
  assert.equal(outcome.status, 'no_draw');
});

test('a broken page is a parser error, never a quiet no_draw', async () => {
  // The distinction this fix turns on. A page with no canonical link at all is
  // Sanook's markup having changed or an error page being served — if that were
  // reported as no_draw it would look exactly like an ordinary unshifted month
  // and the collector would go silently blind.
  await assert.rejects(
    collectVerifiedResult(
      '2026-09-02',
      fetchBySource({
        sanook: async () => '<main>not a lottery page</main>',
        thairath: async () => '<main>not a lottery page</main>',
      }),
      new Date('2026-09-02T10:00:00.000Z'),
    ),
    /parser error/,
  );
});

test('accepts sources that agree on every number but list the tiers in a different order', () => {
  // This is the 2026-09-01 outage. Sanook and Thairath returned identical
  // digits in all 165 prize slots and differed only in sequence; the
  // order-sensitive fingerprint read that as disagreement and the month's
  // biggest draw was never published. Order carries no meaning in a set of
  // 100 fifth-prize numbers.
  const base = completeResult({ source: 'sanook' });
  const shuffled = completeResult({
    source: 'thairath',
    secondPrizes: [...base.secondPrizes].reverse(),
    thirdPrizes: [...base.thirdPrizes].reverse(),
    fourthPrizes: [...base.fourthPrizes].reverse(),
    fifthPrizes: [...base.fifthPrizes].reverse(),
    frontThreeDigits: [...base.frontThreeDigits].reverse(),
    backThreeDigits: [...base.backThreeDigits].reverse(),
  });

  const result = chooseVerifiedResult([base, shuffled], new Date('2026-07-16T10:00:00.000Z'));
  assert.equal(result.firstPrize, '639214');
  // The published payload keeps the winning candidate's own order — only the
  // comparison ignores it. Sorting the payload would change what every
  // installed app renders for the 2nd-5th prize tiers.
  assert.deepEqual(result.fifthPrizes, base.fifthPrizes);
});

test('still rejects sources that disagree on a number, whatever the order', () => {
  // The guard that matters must survive the fix: a genuinely different digit
  // is not an ordering difference, and reversing the list must not hide it.
  const base = completeResult({ source: 'sanook' });
  const wrong = [...base.fifthPrizes].reverse();
  wrong[0] = '999999';

  assert.throws(
    () => chooseVerifiedResult([base, completeResult({ source: 'thairath', fifthPrizes: wrong })],
      new Date('2026-07-16T10:00:00.000Z')),
    /source result mismatch/,
  );
});

test('a differently ordered republish of the same draw is not a change', () => {
  // Without this, whichever source wins a given run flips the stored order and
  // every 5-minute run commits an identical result under a new publishedAt.
  const path = new URL('./tmp-order-churn.json', import.meta.url);
  const result = completeResult();
  try {
    assert.equal(writeIfNewer(result, path), true, 'first publish writes');
    assert.equal(
      writeIfNewer({ ...result, fifthPrizes: [...result.fifthPrizes].reverse() }, path),
      false,
      'the same numbers in another order must not rewrite',
    );
  } finally {
    try { unlinkSync(path); } catch {}
  }
});

test('parses Thairath prizes from the nested Next.js lottery items state', () => {
  const result = completeResult({ source: 'thairath', sources: ['thairath'] });
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { initialState: {
      common: { data: { canonical: 'https://www.thairath.co.th/lottery/check?date=2026-07-16' } },
      lottery: { data: { items: { dates: [{ str: '2026-07-16' }], prizes: {
        1: { data: [result.firstPrize] }, 2: { data: result.secondPrizes }, 3: { data: result.thirdPrizes },
        4: { data: result.fourthPrizes }, 5: { data: result.fifthPrizes }, 6: { data: result.backThreeDigits },
        7: { data: [result.backTwoDigits] }, 10: { data: result.frontThreeDigits }, 11: { data: result.adjacentToFirst },
      } } } },
    } },
  })}</script>`;
  assert.equal(parseThairathPage(html, '2026-07-16').firstPrize, '639214');
});

test('Sanook accepts a page whose canonical URL has the requested draw date', () => {
  const html = '<link rel="canonical" href="https://news.sanook.com/lotto/check/01082569/">';

  assert.equal(parseSanookPage(html, '2026-08-01').drawDate, '2026-08-01');
});

test('Sanook rejects a page whose canonical URL has a previous draw date', () => {
  const html = '<link rel="canonical" href="https://news.sanook.com/lotto/check/16072569/">';

  assert.throws(() => parseSanookPage(html, '2026-08-01'), /page date differs/);
});

test('Sanook rejects a stale canonical path with the requested path in its query', () => {
  const html = '<link rel="canonical" href="https://news.sanook.com/lotto/check/16072569/?next=/lotto/check/01082569/">';

  assert.throws(() => parseSanookPage(html, '2026-08-01'), /page date differs/);
});

test('Sanook rejects a canonical URL from a non-Sanook origin', () => {
  const html = '<link rel="canonical" href="https://example.com/lotto/check/01082569/">';

  // Rejected as a broken page, not as a date mismatch: the date in that URL
  // happens to be the right one, and only the origin is wrong. Classifying it
  // as "no draw on this date" would be both untrue and quiet.
  assert.throws(() => parseSanookPage(html, '2026-08-01'), /no usable canonical link/);
});

test('Sanook accepts canonical attribute variations', () => {
  const canonicalUrls = [
    '<link href = https://news.sanook.com/lotto/check/01082569/ rel = canonical>',
    '<link data-kind="lottery" rel="alternate canonical" href="https://news.sanook.com/lotto/check/01082569/?ref=home">',
  ];

  for (const html of canonicalUrls) {
    assert.equal(parseSanookPage(html, '2026-08-01').drawDate, '2026-08-01');
  }
});

test('Sanook rejects a page without canonical metadata', () => {
  // A page carrying no canonical link says nothing about any date. It is the
  // markup having changed or an error page being served, and it must stay a
  // loud parser error rather than collapse into the ordinary no_draw case.
  assert.throws(() => parseSanookPage('<main></main>', '2026-08-01'), /no usable canonical link/);
});

test('does not rewrite a published result when only publishedAt moved', async (t) => {
  const path = new URL(`./tmp-latest-${process.pid}.json`, import.meta.url);
  const result = completeResult({ drawDate: '2026-08-01', publishedAt: '2026-08-01T08:20:00.000Z' });
  t.after(() => { try { unlinkSync(path); } catch {} });

  assert.equal(writeIfNewer(result, path), true, 'first publish writes');
  assert.equal(writeIfNewer({ ...result, publishedAt: '2026-08-01T08:25:00.000Z' }, path), false, 'same numbers must not rewrite');
  assert.equal(writeIfNewer({ ...result, firstPrize: '654321', adjacentToFirst: ['654320', '654322'] }, path), true, 'corrected numbers do rewrite');
  assert.equal(writeIfNewer({ ...result, drawDate: '2026-07-16' }, path), false, 'never regress to an older draw');
});

test('does not rewrite when an invalid payload is provided', async (t) => {
  const path = new URL(`./tmp-invalid-${process.pid}.json`, import.meta.url);
  const valid = completeResult({ drawDate: '2026-08-01' });
  t.after(() => { try { unlinkSync(path); } catch {} });

  assert.equal(writeIfNewer(valid, path), true, 'first publish writes');
  const previousContents = readFileSync(path, 'utf8');

  assert.throws(
    () => writeIfNewer({ ...valid, fifthPrizes: [] }, path),
    /invalid result/,
  );
  assert.equal(readFileSync(path, 'utf8'), previousContents, 'invalid payload must not rewrite');
});

test('returns waiting for a requested-date partial source before 18:00 ICT', async () => {
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(completeResult({ drawDate: '2026-08-01' }), { includePrizes: false }),
      thairath: async () => { throw new Error('timeout'); },
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'waiting');
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.status), ['partial', 'unavailable']);
  assert.match(outcome.diagnostics[1].message, /timeout/);
});

test('throws for a requested-date partial source at 18:00 ICT', async () => {
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => sanookPage(completeResult({ drawDate: '2026-08-01' }), { includePrizes: false }),
        thairath: async () => { throw new Error('timeout'); },
      }),
      new Date('2026-08-01T11:00:00.000Z'),
    ),
    /18:00 ICT/,
  );
});

test('throws all sources unavailable when both fetches reject', async () => {
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => { throw new Error('sanook connection reset'); },
        thairath: async () => { throw new Error('thairath timeout'); },
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /all sources unavailable/,
  );
});

test('throws parser error for malformed source pages', async () => {
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => '<main>not a lottery page</main>',
        thairath: async () => '<main>not a lottery page</main>',
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /parser error/,
  );
});

test('throws parser error for a dated page with no recognizable lottery structure', async () => {
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => '<link rel="canonical" href="https://news.sanook.com/lotto/check/01082569/"><main></main>',
        thairath: async () => '<main>not a lottery page</main>',
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /parser error/,
  );
});

test('returns a complete result when one complete source is available', async () => {
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(completeResult({ drawDate: '2026-08-01' })),
      thairath: async () => { throw new Error('timeout'); },
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.result.firstPrize, '639214');
  assert.deepEqual(outcome.result.sources, ['sanook']);
});

test('publishes a complete source when a consistent peer is partial', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(result),
      thairath: async () => thairathPage(result, { fifthPrizes: result.fifthPrizes.slice(0, 99) }),
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'complete');
  assert.deepEqual(outcome.result.sources, ['sanook']);
});

test('rejects a partial peer with a conflicting first prize', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => sanookPage(result),
        thairath: async () => thairathPage(result, {
          firstPrize: ['111111'],
          adjacentToFirst: ['111110', '111112'],
          fifthPrizes: result.fifthPrizes.slice(0, 99),
        }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /source partial result mismatch/,
  );
});

test('rejects a partial peer with a conflicting later array element', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const secondPrizes = [...result.secondPrizes];
  secondPrizes[4] = '999999';

  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => sanookPage(result),
        thairath: async () => thairathPage(result, {
          secondPrizes,
          fifthPrizes: result.fifthPrizes.slice(0, 99),
        }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /source partial result mismatch/,
  );
});

test('ignores missing slots from an otherwise consistent partial peer', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(result),
      thairath: async () => thairathPage(result, {
        firstPrize: [],
        adjacentToFirst: [],
        secondPrizes: [],
        backTwoDigits: [],
      }),
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'complete');
  assert.deepEqual(outcome.result.sources, ['sanook']);
});

test('returns a complete source when the other source has a malformed prize shape', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(result),
      thairath: async () => thairathPage(result, { adjacentToFirst: {} }),
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.result.firstPrize, '639214');
});

test('returns a complete source when the other source has an ordinary parser error', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => sanookPage(result),
      thairath: async () => '<main>not a lottery page</main>',
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'complete');
  assert.deepEqual(outcome.result.sources, ['sanook']);
});

test('uses the post-collection clock for a historical draw cutoff', async () => {
  const result = completeResult({ drawDate: '2026-07-16' });
  let collectionFinished = false;
  let clockCalls = 0;
  const clock = () => {
    clockCalls += 1;
    assert.equal(collectionFinished, true, 'clock must be sampled after both source attempts');
    return new Date('2026-07-16T11:00:00.000Z');
  };

  await assert.rejects(
    collectVerifiedResult(
      '2026-07-16',
      fetchBySource({
        sanook: async () => {
          collectionFinished = true;
          return sanookPage(result, { includePrizes: false });
        },
        thairath: async () => { throw new Error('timeout'); },
      }),
      clock,
    ),
    /18:00 ICT/,
  );
  assert.equal(clockCalls, 1);
});

test('treats a fully populated candidate with invalid adjacent prizes as parser error', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => { throw new Error('timeout'); },
        thairath: async () => thairathPage(result, { adjacentToFirst: ['639212', '639215'] }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    (error) => {
      assert.match(error.message, /all sources failed/);
      assert.match(error.message, /thairath: parser_error/);
      return true;
    },
  );
});

test('treats non-array parsed prize fields as parser error rather than waiting', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => '<main>not a lottery page</main>',
        thairath: async () => thairathPage(result, { secondPrizes: {} }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    /parser error/,
  );
});

test('rejects a wrong present adjacent prize when its positional peer is missing', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => { throw new Error('timeout'); },
        thairath: async () => thairathPage(result, { adjacentToFirst: ['000000'] }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    (error) => {
      assert.match(error.message, /all sources failed/);
      assert.match(error.message, /thairath: parser_error/);
      return true;
    },
  );
});

test('rejects an impossible complete adjacent pair when first prize is absent', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  await assert.rejects(
    collectVerifiedResult(
      '2026-08-01',
      fetchBySource({
        sanook: async () => { throw new Error('timeout'); },
        thairath: async () => thairathPage(result, {
          firstPrize: [],
          adjacentToFirst: ['639213', '639216'],
        }),
      }),
      new Date('2026-08-01T10:59:59.000Z'),
    ),
    (error) => {
      assert.match(error.message, /all sources failed/);
      assert.match(error.message, /thairath: parser_error/);
      return true;
    },
  );
});

test('waits on a coherent complete adjacent pair when first prize is absent', async () => {
  const result = completeResult({ drawDate: '2026-08-01' });
  const outcome = await collectVerifiedResult(
    '2026-08-01',
    fetchBySource({
      sanook: async () => { throw new Error('timeout'); },
      thairath: async () => thairathPage(result, {
        firstPrize: [],
        adjacentToFirst: ['639213', '639215'],
      }),
    }),
    new Date('2026-08-01T10:59:59.000Z'),
  );

  assert.equal(outcome.status, 'waiting');
  assert.deepEqual(outcome.diagnostics.map((diagnostic) => diagnostic.status), ['unavailable', 'partial']);
});
