/** Strict contract and collector for Thai Government Lottery results. */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PRIZE_COUNTS = {
  secondPrizes: 5,
  thirdPrizes: 10,
  fourthPrizes: 50,
  fifthPrizes: 100,
};

function isDigits(value, width) {
  return typeof value === 'string' && new RegExp(`^\\d{${width}}$`).test(value);
}

function isFixedNumberList(value, count, width) {
  return Array.isArray(value) && value.length === count && value.every((item) => isDigits(item, width));
}

function computedAdjacent(firstPrize) {
  const number = Number(firstPrize);
  return [String(number - 1).padStart(6, '0'), String(number + 1).padStart(6, '0')];
}

export function validateResult(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'result is not an object' };
  if (value.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.drawDate ?? '')) {
    return { ok: false, reason: 'invalid schema or draw date' };
  }
  if (!isDigits(value.firstPrize, 6) || !isDigits(value.backTwoDigits, 2)) {
    return { ok: false, reason: 'invalid first or back-two prize' };
  }
  if (!isFixedNumberList(value.adjacentToFirst, 2, 6) || !isFixedNumberList(value.frontThreeDigits, 2, 3) || !isFixedNumberList(value.backThreeDigits, 2, 3)) {
    return { ok: false, reason: 'invalid running numbers' };
  }
  for (const [field, count] of Object.entries(PRIZE_COUNTS)) {
    if (!isFixedNumberList(value[field], count, 6)) return { ok: false, reason: `invalid ${field}` };
  }
  const [previous, next] = computedAdjacent(value.firstPrize);
  if (value.adjacentToFirst[0] !== previous || value.adjacentToFirst[1] !== next) {
    return { ok: false, reason: 'adjacent prizes do not surround first prize' };
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0 || !value.sources.every((source) => source === 'sanook' || source === 'thairath')) {
    return { ok: false, reason: 'invalid source list' };
  }
  return { ok: true, value };
}

/** Combine independently parsed, complete source results into the public payload. */
export function chooseVerifiedResult(candidates, now = new Date()) {
  const complete = candidates.filter((candidate) => validateResult(candidate).ok);
  if (complete.length === 0) throw new Error('no complete valid source result');
  const [first] = complete;
  const fingerprint = canonicalResultFingerprint(first);
  if (complete.some((candidate) => canonicalResultFingerprint(candidate) !== fingerprint)) {
    throw new Error('source result mismatch');
  }
  const sources = [...new Set(complete.map((candidate) => candidate.source))];
  return {
    ...first,
    source: 'verified-bot',
    sources,
    publishedAt: now.toISOString(),
  };
}

function slice(html, start, end) {
  const index = html.search(start);
  if (index < 0) return '';
  const rest = html.slice(index);
  const endIndex = rest.search(end);
  return endIndex < 0 ? rest : rest.slice(0, endIndex);
}

function visibleNumbers(chunk, digits) {
  return [...chunk.matchAll(/class="lotto__number(?:[^"]*)">(\d+)/g)]
    .map((match) => match[1])
    .filter((number) => number.length === digits);
}

function isoToSanookSlug(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}${month}${Number(year) + 543}`;
}

function publishedCandidate(data, source) {
  return { schemaVersion: 1, source, sources: [source], publishedAt: new Date().toISOString(), ...data };
}

/** Parse Sanook's rendered lottery cards, intentionally ignoring JSON-LD summaries. */
export function parseSanookPage(html, drawDate) {
  const page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const firstPrize = page.match(/class="lotto__number lotto__number--first">(\d{6})</)?.[1] ?? '';
  const frontThreeDigits = visibleNumbers(slice(page, /เลขหน้า 3 ตัว/, /เลขท้าย 3 ตัว/), 3);
  const backThreeDigits = visibleNumbers(slice(page, /เลขท้าย 3 ตัว/, /เลขท้าย 2 ตัว/), 3);
  const backTwoDigits = visibleNumbers(slice(page, /เลขท้าย 2 ตัว/, /lottocheck__sec--nearby|รางวัลที่ 2 มี/), 2);
  const adjacentToFirst = visibleNumbers(slice(page, /lottocheck__sec--nearby/, /รางวัลที่ 2 มี/), 6);
  const secondPrizes = visibleNumbers(slice(page, /รางวัลที่ 2 มี/, /รางวัลที่ 3 มี/), 6);
  const thirdPrizes = visibleNumbers(slice(page, /รางวัลที่ 3 มี/, /รางวัลที่ 4 มี/), 6);
  const fourthPrizes = visibleNumbers(slice(page, /รางวัลที่ 4 มี/, /รางวัลที่ 5 มี/), 6);
  const fifthPrizes = visibleNumbers(slice(page, /รางวัลที่ 5 มี/, /<\/main|<footer|lotto-form/), 6);
  return publishedCandidate({
    drawDate,
    firstPrize,
    adjacentToFirst,
    secondPrizes,
    thirdPrizes,
    fourthPrizes,
    fifthPrizes,
    frontThreeDigits,
    backThreeDigits,
    backTwoDigits: backTwoDigits[0] ?? '',
  }, 'sanook');
}

/** Parse Thairath's server-rendered Next.js state instead of brittle CSS classes. */
export function parseThairathPage(html, expectedDate) {
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) throw new Error('thairath: missing __NEXT_DATA__');
  const state = JSON.parse(raw).props?.initialState;
  const lottery = state?.lottery?.data?.items;
  const canonical = state?.common?.data?.canonical ?? '';
  if (!canonical.includes(`date=${expectedDate}`) || !lottery?.dates?.some((date) => date.str === expectedDate)) {
    throw new Error(`thairath: requested ${expectedDate} but page date differs`);
  }
  const prizes = lottery.prizes;
  return publishedCandidate({
    drawDate: expectedDate,
    firstPrize: prizes?.['1']?.data?.[0] ?? '',
    adjacentToFirst: prizes?.['11']?.data ?? [],
    secondPrizes: prizes?.['2']?.data ?? [],
    thirdPrizes: prizes?.['3']?.data ?? [],
    fourthPrizes: prizes?.['4']?.data ?? [],
    fifthPrizes: prizes?.['5']?.data ?? [],
    frontThreeDigits: prizes?.['10']?.data ?? [],
    backThreeDigits: prizes?.['6']?.data ?? [],
    backTwoDigits: prizes?.['7']?.data?.[0] ?? '',
  }, 'thairath');
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'HuayCheck verified-result collector' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

export async function collectVerifiedResult(drawDate, fetchPage = fetchHtml, now = new Date()) {
  const sanookUrl = `https://news.sanook.com/lotto/check/${isoToSanookSlug(drawDate)}/`;
  const thairathUrl = `https://www.thairath.co.th/lottery/check?date=${drawDate}`;
  const settled = await Promise.allSettled([
    fetchPage(sanookUrl).then((html) => parseSanookPage(html, drawDate)),
    fetchPage(thairathUrl).then((html) => parseThairathPage(html, drawDate)),
  ]);
  const candidates = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []);
  return chooseVerifiedResult(candidates, now);
}

function todayInIct(now = new Date()) {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function mayBeDrawDay(isoDate) {
  return [1, 2, 16, 17, 30].includes(Number(isoDate.slice(-2)));
}

function readLatest(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function canonicalResultFingerprint(value) {
  const { source, sources, publishedAt, ...canonical } = value;
  return JSON.stringify(canonical);
}

export function writeIfNewer(result, path) {
  const validation = validateResult(result);
  if (!validation.ok) throw new Error(`invalid result: ${validation.reason}`);
  const previous = readLatest(path);
  if (previous?.drawDate && previous.drawDate > result.drawDate) return false;
  // Compare on the fingerprint, not the whole object: once a draw is published,
  // every remaining run in the window re-collects the same numbers with a fresh
  // publishedAt, and comparing that would commit an identical result every
  // 5 minutes for the rest of the afternoon.
  if (previous && canonicalResultFingerprint(previous) === canonicalResultFingerprint(result)) return false;
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return true;
}

async function main() {
  // `||`, not `??`: workflow_dispatch inputs arrive as an empty string on every
  // scheduled run, and `'' ?? x` keeps the empty string — which would fail the
  // draw-day check forever.
  const drawDate = process.env.DRAW_DATE || todayInIct();
  if (process.env.FORCE !== '1' && !mayBeDrawDay(drawDate)) {
    console.log(`${drawDate} is not a scheduled collection day`);
    return;
  }
  const result = await collectVerifiedResult(drawDate);
  const changed = writeIfNewer(result, new URL('./data/thai-latest.json', import.meta.url));
  console.log(changed ? `published ${result.drawDate} from ${result.sources.join(', ')}` : 'verified result unchanged');
}

// `import.meta.main` only exists from Node 22.16 / 24.2 — on the Node 20 runner
// used by the workflow it is `undefined`, so main() silently never ran and the
// job still exited 0. Keep the portable argv comparison as the fallback.
const invokedDirectly = import.meta.main
  ?? (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
