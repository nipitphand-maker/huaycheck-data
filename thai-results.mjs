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

function linkAttribute(tag, name) {
  const attribute = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const match = tag.match(attribute);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function sanookCanonicalUrl(html) {
  const links = html.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];
  for (const link of links) {
    const rel = linkAttribute(link, 'rel');
    if (rel.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')) {
      return linkAttribute(link, 'href');
    }
  }
  return '';
}

function publishedCandidate(data, source) {
  return { schemaVersion: 1, source, sources: [source], publishedAt: new Date().toISOString(), ...data };
}

/** Parse Sanook's rendered lottery cards, intentionally ignoring JSON-LD summaries. */
export function parseSanookPage(html, drawDate) {
  const expectedPath = `/lotto/check/${isoToSanookSlug(drawDate)}/`;
  let canonical;
  try { canonical = new URL(sanookCanonicalUrl(html)); } catch { canonical = null; }
  if (canonical?.origin !== 'https://news.sanook.com' || canonical.pathname !== expectedPath) {
    throw new Error(`sanook: requested ${drawDate} but page date differs`);
  }
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function classifyParsedCandidate(candidate, drawDate, source) {
  const validation = validateResult(candidate);
  if (validation.ok) return { status: 'complete', candidate };
  if (!candidate || typeof candidate !== 'object' || candidate.schemaVersion !== 1 || candidate.drawDate !== drawDate) {
    return { status: 'parser_error', message: validation.reason };
  }
  if (candidate.source !== source || !Array.isArray(candidate.sources) || candidate.sources.length !== 1 || candidate.sources[0] !== source) {
    return { status: 'parser_error', message: 'invalid source metadata' };
  }

  let missingPrizeSlot = false;
  let recognizablePrizeSlot = false;
  const scalarSlots = [
    ['first prize', candidate.firstPrize, 6],
    ['back-two prize', candidate.backTwoDigits, 2],
  ];
  for (const [name, value, width] of scalarSlots) {
    if (value === '') {
      missingPrizeSlot = true;
      continue;
    }
    if (!isDigits(value, width)) return { status: 'parser_error', message: `invalid ${name}` };
    recognizablePrizeSlot = true;
  }

  const listSlots = [
    ['adjacent prizes', candidate.adjacentToFirst, 2, 6],
    ['second prizes', candidate.secondPrizes, PRIZE_COUNTS.secondPrizes, 6],
    ['third prizes', candidate.thirdPrizes, PRIZE_COUNTS.thirdPrizes, 6],
    ['fourth prizes', candidate.fourthPrizes, PRIZE_COUNTS.fourthPrizes, 6],
    ['fifth prizes', candidate.fifthPrizes, PRIZE_COUNTS.fifthPrizes, 6],
    ['front-three prizes', candidate.frontThreeDigits, 2, 3],
    ['back-three prizes', candidate.backThreeDigits, 2, 3],
  ];
  for (const [name, values, count, width] of listSlots) {
    if (!Array.isArray(values)) return { status: 'parser_error', message: `invalid ${name} shape` };
    if (values.length > count || !values.every((value) => isDigits(value, width))) {
      return { status: 'parser_error', message: `invalid ${name}` };
    }
    if (values.length < count) missingPrizeSlot = true;
    if (values.length > 0) recognizablePrizeSlot = true;
  }

  if (candidate.firstPrize !== '') {
    const [previous, next] = computedAdjacent(candidate.firstPrize);
    if (candidate.adjacentToFirst.some((value, index) => value !== [previous, next][index])) {
      return { status: 'parser_error', message: 'adjacent prizes do not surround first prize' };
    }
  } else if (candidate.adjacentToFirst.length === 2) {
    const inferredFirst = String(Number(candidate.adjacentToFirst[0]) + 1).padStart(6, '0');
    const [previous, next] = computedAdjacent(inferredFirst);
    if (!isDigits(inferredFirst, 6) || candidate.adjacentToFirst[0] !== previous || candidate.adjacentToFirst[1] !== next) {
      return { status: 'parser_error', message: 'adjacent prizes cannot surround a first prize' };
    }
  }
  if (!recognizablePrizeSlot) return { status: 'parser_error', message: 'no recognizable lottery structure' };
  if (missingPrizeSlot) return { status: 'partial', candidate, message: validation.reason };
  return { status: 'parser_error', message: validation.reason };
}

async function collectSourceOutcome({ source, url, parse }, drawDate, fetchPage) {
  let html;
  try {
    html = await fetchPage(url);
  } catch (error) {
    return { status: 'unavailable', source, message: errorMessage(error) };
  }

  try {
    const classification = classifyParsedCandidate(parse(html, drawDate), drawDate, source);
    return { ...classification, source };
  } catch (error) {
    return { status: 'parser_error', source, message: errorMessage(error) };
  }
}

function formatDiagnostics(outcomes) {
  return outcomes.map(({ source, status, message }) => `${source}: ${status}${message ? ` (${message})` : ''}`).join('; ');
}

function partialResultMismatch(source, reason) {
  throw new Error(`source partial result mismatch: ${source}: ${reason}`);
}

function assertPartialResultMatches(completeResult, { candidate, source }) {
  if (!candidate || typeof candidate !== 'object' || candidate.schemaVersion !== 1) {
    partialResultMismatch(source, 'invalid schema metadata');
  }
  if (candidate.drawDate !== completeResult.drawDate) {
    partialResultMismatch(source, 'draw date differs');
  }
  if (candidate.source !== source || !Array.isArray(candidate.sources) || candidate.sources.length !== 1 || candidate.sources[0] !== source) {
    partialResultMismatch(source, 'source metadata differs');
  }

  const scalarSlots = [
    ['firstPrize', 6],
    ['backTwoDigits', 2],
  ];
  for (const [field, width] of scalarSlots) {
    const value = candidate[field];
    if (value === '') continue;
    if (!isDigits(value, width) || value !== completeResult[field]) {
      partialResultMismatch(source, `${field} differs`);
    }
  }

  const listSlots = [
    ['adjacentToFirst', 6],
    ['secondPrizes', 6],
    ['thirdPrizes', 6],
    ['fourthPrizes', 6],
    ['fifthPrizes', 6],
    ['frontThreeDigits', 3],
    ['backThreeDigits', 3],
  ];
  for (const [field, width] of listSlots) {
    const values = candidate[field];
    const completeValues = completeResult[field];
    if (!Array.isArray(values) || values.length > completeValues.length) {
      partialResultMismatch(source, `invalid ${field} count`);
    }
    for (let index = 0; index < values.length; index += 1) {
      if (!isDigits(values[index], width) || values[index] !== completeValues[index]) {
        partialResultMismatch(source, `${field}[${index}] differs`);
      }
    }
  }
}

export async function collectVerifiedResult(drawDate, fetchPage = fetchHtml, now = () => new Date()) {
  const sanookUrl = `https://news.sanook.com/lotto/check/${isoToSanookSlug(drawDate)}/`;
  const thairathUrl = `https://www.thairath.co.th/lottery/check?date=${drawDate}`;
  const outcomes = await Promise.all([
    collectSourceOutcome({ source: 'sanook', url: sanookUrl, parse: parseSanookPage }, drawDate, fetchPage),
    collectSourceOutcome({ source: 'thairath', url: thairathUrl, parse: parseThairathPage }, drawDate, fetchPage),
  ]);
  const collectedAt = typeof now === 'function' ? now() : now;
  const candidates = outcomes.flatMap((outcome) => outcome.status === 'complete' ? [outcome.candidate] : []);
  if (candidates.length > 0) {
    const result = chooseVerifiedResult(candidates, collectedAt);
    for (const outcome of outcomes.filter((outcome) => outcome.status === 'partial')) {
      assertPartialResultMatches(result, outcome);
    }
    return { status: 'complete', result };
  }

  if (outcomes.some((outcome) => outcome.status === 'partial')) {
    const cutoff = new Date(`${drawDate}T11:00:00.000Z`);
    if (collectedAt < cutoff) return { status: 'waiting', diagnostics: outcomes };
    throw new Error(`incomplete source result after 18:00 ICT: ${formatDiagnostics(outcomes)}`);
  }

  const diagnostics = formatDiagnostics(outcomes);
  if (outcomes.every((outcome) => outcome.status === 'unavailable')) {
    throw new Error(`all sources unavailable: ${diagnostics}`);
  }
  if (outcomes.every((outcome) => outcome.status === 'parser_error')) {
    throw new Error(`parser error: ${diagnostics}`);
  }
  throw new Error(`all sources failed: ${diagnostics}`);
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

// Prize tiers where the numbers are a SET — the announcement lists them in
// whatever order it likes and no meaning attaches to the sequence. Sanook and
// Thairath genuinely do order them differently.
//
// Deliberately excluded: `firstPrize` and `backTwoDigits` are scalars, and
// `adjacentToFirst` is positional — it is [previous, next] around the first
// prize and validateResult checks it against firstPrize. Sorting that pair
// would silently defeat the check.
const UNORDERED_PRIZE_FIELDS = [
  'secondPrizes', 'thirdPrizes', 'fourthPrizes', 'fifthPrizes',
  'frontThreeDigits', 'backThreeDigits',
];

/**
 * Identity of a result, ignoring which source reported it, when, and in what
 * order the unordered tiers were listed.
 *
 * The ordering part is not a nicety. This fingerprint is what decides whether
 * two sources "agree", and a plain JSON.stringify is order-sensitive: on
 * 2026-09-01 Sanook and Thairath returned identical digits in all 165 prize
 * slots, differing only in sequence, and the collector rejected the draw as a
 * `source result mismatch`. The 1 Sep result was never published — the biggest
 * draw of the month, lost to a false positive in the cross-verification.
 *
 * This does not weaken "late is better than wrong": that rule is about never
 * publishing a number no source confirmed, and every number here is confirmed
 * by both. The published payload still carries the winning candidate's own
 * order; only the comparison is order-insensitive.
 */
function canonicalResultFingerprint(value) {
  const { source, sources, publishedAt, ...canonical } = value;
  for (const field of UNORDERED_PRIZE_FIELDS) {
    if (Array.isArray(canonical[field])) canonical[field] = [...canonical[field]].sort();
  }
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
  const outcome = await collectVerifiedResult(drawDate);
  if (outcome.status === 'waiting') {
    console.log(`Waiting for complete result: ${formatDiagnostics(outcome.diagnostics)}`);
    return;
  }
  const changed = writeIfNewer(outcome.result, new URL('./data/thai-latest.json', import.meta.url));
  console.log(changed ? `published ${outcome.result.drawDate} from ${outcome.result.sources.join(', ')}` : 'verified result unchanged');
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
