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
  const slug = '01082569';
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

  assert.throws(() => parseSanookPage(html, '2026-08-01'), /page date differs/);
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
  assert.throws(() => parseSanookPage('<main></main>', '2026-08-01'), /page date differs/);
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
