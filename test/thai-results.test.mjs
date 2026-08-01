import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, unlinkSync } from 'node:fs';

import { chooseVerifiedResult, parseSanookPage, parseThairathPage, validateResult, writeIfNewer } from '../thai-results.mjs';

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
