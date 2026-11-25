/**
 * scrape.mjs — Aggregate "เลขยอดนิยม" (popular lucky numbers) for the upcoming
 * Thai government lottery draw from public news articles.
 *
 * Sources: Kapook lottery hub + Sanook lotto index. Both publish per-สำนัก
 * articles with a stable textual structure:
 *   เลขเด่น ได้แก่ 3 - 5 - 95 ...
 *   เลขท้ายสองตัว ได้แก่ 98 - 90 ...
 *   เลขท้ายสามตัว ได้แก่ 825 - 826
 *
 * Output: data/lucky-numbers.json — consumed by the HuayCheck app via
 * raw.githubusercontent.com (same zero-backend pattern as the app's Hanoi
 * fetch). Run by GitHub Actions cron; commits only when content changes.
 *
 * No dependencies — plain Node 20+ (global fetch).
 */

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const MAX_ARTICLES_PER_SITE = 10;
const FETCH_DELAY_MS = 700;

// ── Draw date ───────────────────────────────────────────────────────────────

const THAI_MONTHS_FULL = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];
const THAI_MONTHS_ABBR = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** Next nominal Thai draw (1st/16th) in ICT. Holiday shifts don't matter here —
 *  news headlines always use the nominal date. */
function nextDraw() {
  const ict = new Date(Date.now() + 7 * 3600 * 1000);
  let y = ict.getUTCFullYear();
  let m = ict.getUTCMonth(); // 0-based
  const d = ict.getUTCDate();
  let day;
  if (d < 2) day = 1;
  else if (d < 17) day = 16;
  else {
    day = 1;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return { y, m, day };
}

/** All textual forms a Thai news headline uses for this draw date. */
function dateForms({ y, m, day }) {
  const be = y + 543;
  const be2 = String(be).slice(-2);
  return [
    `${day}/${m + 1}/${be2}`,
    `${day}/${m + 1}/${be}`,
    `${day} ${THAI_MONTHS_ABBR[m]} ${be2}`,
    `${day} ${THAI_MONTHS_ABBR[m]} ${be}`,
    `${day} ${THAI_MONTHS_FULL[m]} ${be2}`,
    `${day} ${THAI_MONTHS_FULL[m]} ${be}`,
  ];
}

// ── HTML helpers ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Number extraction ───────────────────────────────────────────────────────

const SECTIONS = [
  { key: 'three', re: /เลขท้าย\s*(?:สาม|๓|3)\s*ตัว|เลขสามตัว|สามตัว(?:ตรง|บน)|3\s*ตัว(?:ตรง|บน)/g },
  { key: 'two', re: /เลขท้าย\s*(?:สอง|๒|2)\s*ตัว|เลขสองตัว|สองตัว(?:ตรง|บน|ล่าง)|2\s*ตัว(?:ตรง|บน|ล่าง)/g },
  { key: 'lead', re: /เลขเด่น|เลขนำโชค|เลขมงคล|เลขหัวปฏิทิน/g },
];

/** Strip date-ish noise so "งวด 16/6/69" never leaks into the number lists. */
function stripDates(s) {
  return s
    .replace(/\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}/g, ' ')
    .replace(
      /\d{1,2}\s*(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s*\d{0,4}/g,
      ' ',
    )
    .replace(/\d{4,}/g, ' '); // years (2569) and anything longer than 3 digits
}

/**
 * Extract lead/two/three digit lists from article text. For each section
 * marker, scan the following span (up to the next marker or 250 chars) for
 * digit groups.
 */
function extractNumbers(text) {
  const found = { lead: new Set(), two: new Set(), three: new Set() };

  // Marker positions across all sections, sorted, so each span ends at the
  // next marker of ANY kind.
  const markers = [];
  for (const { key, re } of SECTIONS) {
    for (const m of text.matchAll(re)) {
      markers.push({ key, index: m.index, end: m.index + m[0].length });
    }
  }
  markers.sort((a, b) => a.index - b.index);

  markers.forEach((marker, i) => {
    const spanEnd = Math.min(
      i + 1 < markers.length ? markers[i + 1].index : text.length,
      marker.end + 250,
    );
    const span = stripDates(text.slice(marker.end, spanEnd));
    const groups = span.match(/\d{1,3}/g) ?? [];
    for (const g of groups) {
      if (marker.key === 'three' && g.length === 3) found.three.add(g);
      else if (marker.key === 'two' && g.length === 2) found.two.add(g);
      else if (marker.key === 'lead' && g.length <= 2) found.lead.add(g);
    }
  });

  return {
    lead: [...found.lead].slice(0, 10),
    two: [...found.two].slice(0, 20),
    three: [...found.three].slice(0, 10),
  };
}

/** Pull a readable สำนัก/source name out of an article title. */
const KNOWN_NAMES = [
  'แม่น้ำหนึ่ง', 'เจ๊ฟองเบียร์', 'คำชะโนด', 'ปฏิทินจีน', 'ปฏิทินครอบครัวข่าว',
  'ม้าสีหมอก', 'พุ่มพวง', 'ไอ้ไข่', 'ท้าวเวสสุวรรณ', 'เสือตกถัง', 'พญาเต่างอย',
  'แม่จำเนียร', 'บ้านสีฟ้า', 'หวยซอง', 'หลวงพ่อปากแดง', 'หลวงพ่อใหญ่วัดห้วยสูบ',
  'แปลปกสลาก', 'เลขธูป', 'ทะเบียนรถนายก', 'อาจารย์หนู',
];

function sourceName(title) {
  for (const n of KNOWN_NAMES) {
    if (title.includes(n)) return n.startsWith('หวย') || n.startsWith('เลข') ? n : `หวย${n}`;
  }
  // Fallback: trimmed title without clickbait punctuation.
  return title.replace(/[!"“”]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 140); // full headline — app wraps it
}

// ── Site scrapers ───────────────────────────────────────────────────────────

async function scrapeKapook(forms) {
  const hub = await fetchHtml('https://lottery.kapook.com/luckynumber');
  const cards = [...hub.matchAll(
    /<a[^>]+href="(https:\/\/lottery\.kapook\.com\/view\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g,
  )];
  const seen = new Set();
  const picks = [];
  for (const [, url, inner] of cards) {
    if (seen.has(url)) continue;
    seen.add(url);
    const cardText = htmlToText(inner);
    if (!cardText.includes('เลขเด็ด') && !cardText.includes('หวย')) continue;
    if (!forms.some((f) => cardText.includes(f))) continue;
    picks.push({ url, title: cardText.slice(0, 120) });
    if (picks.length >= MAX_ARTICLES_PER_SITE) break;
  }

  const out = [];
  for (const pick of picks) {
    try {
      await sleep(FETCH_DELAY_MS);
      const text = htmlToText(await fetchHtml(pick.url));
      const numbers = extractNumbers(text);
      if (numbers.two.length + numbers.three.length + numbers.lead.length === 0) continue;
      out.push({ site: 'kapook', name: sourceName(pick.title), url: pick.url, ...numbers });
    } catch (e) {
      console.warn(`kapook article failed: ${pick.url}: ${e.message}`);
    }
  }
  return out;
}

/** Tip-sheet images uploaded for this article (s.isanook.com/ns/0/ud/<n>/<id>/x.jpg),
 *  minus the generated thumbnail. Exported for tests. */
export function sanookImages(html, url) {
  const id = url.match(/(\d+)\/?$/)?.[1];
  if (!id) return [];
  const re = new RegExp(`https://s\\.isanook\\.com/ns/0/ud/\\d+/${id}/[\\w-]+\\.(?:jpg|jpeg|png|webp)`, 'g');
  return [...new Set(html.match(re) ?? [])].filter((u) => !/thumbnail/i.test(u)).slice(0, 4);
}

/** "สำนัก : เลข" lines exactly as the article lists them. Stops at the
 *  related-news block ("ข่าวหวย : …" teasers of other articles). Exported for tests. */
export function articleLines(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(p|li|h[1-6]|br|div|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
  const out = [];
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+/g, ' ').trim();
    const m = l.match(/^([^:]{2,70}?)\s*:\s*(.+)$/);
    if (!m || l.length > 220) continue;
    const [, label, body] = m;
    if (/ข่าวหวย/.test(label)) break;
    if (/พิมพ์$|น\.\)/.test(body)) continue; // byline timestamp "06 : 47 น.) พิมพ์"
    const nums = body.match(/\d{2,4}/g) ?? [];
    // Prose with a stray number (e.g. explanations) isn't a tip line.
    if (nums.length === 0 || (body.length > 60 && nums.length * 15 < body.length)) continue;
    out.push({ label, text: body });
    if (out.length >= 40) break;
  }
  return out;
}

async function scrapeSanook(forms) {
  const hub = await fetchHtml('https://news.sanook.com/lotto/');
  const anchors = [...hub.matchAll(
    /href="(https:\/\/(?:news\.sanook\.com|www\.sanook\.com\/news)\/\d+\/?)"[^>]*title="([^"]*)"/g,
  )];
  const seen = new Set();
  const picks = [];
  for (const [, url, rawTitle] of anchors) {
    if (seen.has(url)) continue;
    seen.add(url);
    const title = rawTitle.replace(/&quot;/g, '"');
    if (!/เลขเด็ด|เลขมงคล|แนวทางหวย|เลขธูป|เลขขายดี|ใบหวย/.test(title)) continue;
    if (!forms.some((f) => title.includes(f))) continue;
    picks.push({ url, title });
    if (picks.length >= MAX_ARTICLES_PER_SITE) break;
  }

  const out = [];
  for (const pick of picks) {
    try {
      await sleep(FETCH_DELAY_MS);
      const html = await fetchHtml(pick.url);
      const numbers = extractNumbers(htmlToText(html));
      const images = sanookImages(html, pick.url);
      const lines = articleLines(html);
      if (numbers.two.length + numbers.three.length + numbers.lead.length === 0 && !lines.length) continue;
      out.push({ site: 'sanook', name: sourceName(pick.title), url: pick.url, ...numbers, lines, images });
    } catch (e) {
      console.warn(`sanook article failed: ${pick.url}: ${e.message}`);
    }
  }
  return out;
}

// ── Aggregate + write ───────────────────────────────────────────────────────

function aggregate(sources, key, topN) {
  const counts = new Map();
  for (const s of sources) {
    for (const n of s[key]) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([digits, mentions]) => ({ digits, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.digits.localeCompare(b.digits))
    .slice(0, topN);
}

async function main() {
  const draw = nextDraw();
  const forms = dateForms(draw);
  const drawDate = `${draw.y}-${String(draw.m + 1).padStart(2, '0')}-${String(draw.day).padStart(2, '0')}`;
  console.log(`Target draw: ${drawDate} (${forms.join(' | ')})`);

  const results = await Promise.allSettled([scrapeKapook(forms), scrapeSanook(forms)]);
  const sources = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  for (const r of results) {
    if (r.status === 'rejected') console.warn(`site failed: ${r.reason?.message}`);
  }

  // Dedup near-identical สำนัก across sites (Kapook + Sanook both cover
  // คำชะโนด etc.) — keep the one with more numbers.
  const byName = new Map();
  for (const s of sources) {
    const prev = byName.get(s.name);
    const size = (x) => x.lead.length + x.two.length + x.three.length;
    if (!prev || size(s) > size(prev)) byName.set(s.name, s);
  }
  const deduped = [...byName.values()];

  const payload = {
    schemaVersion: 1,
    drawDate,
    drawDateThai: `${draw.day} ${THAI_MONTHS_FULL[draw.m]} ${draw.y + 543}`,
    generatedAt: new Date().toISOString(),
    sourceCount: deduped.length,
    sources: deduped,
    topTwo: aggregate(deduped, 'two', 10),
    topThree: aggregate(deduped, 'three', 10),
  };

  mkdirSync('data', { recursive: true });
  // generatedAt changes every run — write a stable companion the workflow can
  // diff against so we only commit when actual content changed.
  const { generatedAt, ...stable } = payload;
  writeFileSync('data/lucky-numbers.json', JSON.stringify(payload, null, 2) + '\n');
  writeFileSync('data/.content-hash', JSON.stringify(stable));
  console.log(
    `Wrote ${deduped.length} sources, topTwo=[${payload.topTwo.slice(0, 5).map((t) => t.digits)}]`,
  );
  // Breakage alarm: Sanook always has tip articles in the last days before a
  // draw. Zero from Sanook then = markup/link change → fail the run so GitHub
  // emails the owner (data above is still written and committed).
  const sanookCount = sources.filter((x) => x.site === 'sanook').length;
  const daysLeft = (Date.UTC(draw.y, draw.m, draw.day) - Date.now()) / 86_400_000;
  if (sanookCount === 0 && daysLeft <= 4) {
    console.error(`ALERT: Sanook returned 0 sources ${daysLeft.toFixed(1)} days before the draw — scraper likely broken.`);
    // Signal via step output; the workflow fails AFTER committing good data.
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'alarm=sanook_zero\n');
  }
  if (deduped.length === 0) {
    // Don't hard-fail: an empty window (right after a draw, before new
    // articles) is normal. The app shows its own "ยังไม่มีข้อมูล" state.
    console.warn('No sources extracted — likely between draws or markup changed.');
  }
}

// Guarded so tests can import helpers (import.meta.main needs Node 22.16+).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
