#!/usr/bin/env node
// Loads the real page in a real browser and asserts it rendered. This is the
// only check that catches the failure the old single-file page was prone to:
// data that looks fine but throws during render, leaving a blank screen.
//
//   node tools/smoke.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normalize } from '../assets/data.js';
import { unitMatch } from '../assets/tables.js';
import { MODELS } from '../assets/models.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Playwright may be installed globally rather than in the repo, since this is a
// static site with no package.json.
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    `${process.env.HOME}/.npm-global/lib/node_modules/playwright`,
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {}
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  console.error('✗ smoke test needs playwright: npm i -g playwright');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, rel);
  // Refuse to serve outside the repo even in a throwaway test server.
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(name);
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => pw.chromium.launch());
const page = await browser.newPage();

// Google Fonts is the only remaining third-party request. A blocked or flaky
// CDN is not a regression in this repo, so only same-origin failures count.
const ours = url => !url || url.startsWith(base);
const consoleErrors = [];
page.on('console', m => {
  if (m.type() === 'error' && ours(m.location()?.url)) consoleErrors.push(m.text());
});
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('requestfailed', r => {
  if (ours(r.url())) consoleErrors.push(`request failed: ${r.url()}`);
});

// Expectations come from the data itself, through the same pure functions the
// page uses, so adding a unit or a reading never means editing a count here.
const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));
const model = normalize(doc);
const NO_FILTER = { fmt: new Set(), fmtUnknownOk: false, bwMin: null, bwMax: null, memMin: null, memMax: null, priceMin: null, priceMax: null, vendorsOff: new Set() };
const expectMatch = filter => model.UNITS.filter(u => unitMatch(u, { ...NO_FILTER, ...filter }).ok).map(u => u.label);
const totalPoints = model.LINES.reduce((n, l) => n + l.points.length, 0);
// A failed number renders as one of these. "Infinity Fabric" is AMD's interconnect, not a division by zero.
const BROKEN = /\bNaN\b|\bundefined\b|\bnull\b|Infinity(?! Fabric)/;
const brokenAt = t => t.match(new RegExp(`.{0,30}(${BROKEN.source}).{0,30}`))?.[0];

const text = async (sel, p = page) => (await p.locator(sel).first().textContent())?.trim() ?? '';
const count = async (sel, p = page) => await p.locator(sel).count();
/** Open one of the page's tabs, as a reader would. */
const openTab = async (id, p = page) => {
  await p.click(`[role="tab"][data-tab="${id}"]`);
  await p.waitForTimeout(60);
};
const canvasPainted = async (id, p = page) =>
  await p.evaluate(sel => {
    const c = document.querySelector(sel);
    if (!c || !c.width || !c.height) return false;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
    return false;
  }, `#${id}`);
const settle = () => page.waitForTimeout(60);
const usd = v => `$${Math.round(v).toLocaleString('en-US')}`;
// The numeric controls are range inputs: drive them the way a person would,
// by typing into a slider's number box, or by moving its handle.
async function setBox(sel, value, p = page) {
  await p.locator(sel).fill(String(value));
  await p.locator(sel).press('Tab');
  await p.waitForTimeout(60);
}
async function setHandle(sel, pos, p = page) {
  await p.locator(sel).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, pos);
  await p.waitForTimeout(60);
}
// Depth runs 1K to 256K on a log scale over 200 steps.
const depthPos = tokens => Math.round((Math.log(tokens / 1024) / Math.log(256)) * 200);
async function setCards(n) {
  if (n === 'auto') {
    if (!(await page.isChecked('#cardsAuto'))) await page.check('#cardsAuto');
  } else {
    if (await page.isChecked('#cardsAuto')) await page.uncheck('#cardsAuto');
    await setHandle('#cardSlider input', n);
  }
  await page.waitForTimeout(60);
}
const hwLabels = async (p = page) =>
  (await p.locator('#hwTable tbody tr td:first-child > span:first-child').allTextContents()).map(t => t.trim());

await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });

check('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('error banner stays hidden', await page.locator('#loadError').isHidden());

// --- 1. Hardware -----------------------------------------------------------
check('every unit is listed with no filter', (await count('#hwTable tbody tr')) === model.UNITS.length, `got ${await count('#hwTable tbody tr')} of ${model.UNITS.length}`);
check('eight format chips', (await count('#fmtChips button')) === 8);
check('format badges on every row', (await count('#hwTable tbody .fmt')) === model.UNITS.length * 8);
check('scatter painted', await canvasPainted('scatterChart'));
check('hardware summary rendered', /of \d+ units match/.test(await text('#hwSummary')));
{
  // Every FP16 figure the vendor never published carries its mark, and no other.
  const p = await browser.newPage();
  await p.goto(`${base}/index.html#prec=fp16`, { waitUntil: 'networkidle' });
  const want = model.UNITS.reduce((n, u) => n + ['fp16', 'fp16:sparse', 'fp16:vector'].filter(k => u.compute?.values?.[k] != null && u.compute.unofficial?.includes(k)).length, 0);
  const got = await count('#hwTable tbody td span[title^="Not the vendor"]', p);
  check('unofficial FP16 figures are marked', want > 0 && got === want, `${got} marks for ${want} unofficial figures`);
  // The chart has no asterisks, so its caption counts them and the tooltip names them.
  // The key a unit is plotted at: dense FP16, or the vector rate on a card with no matrix units.
  const keyOf = u => {
    const v = u.compute?.values ?? {};
    if (v.fp16 != null) return 'fp16';
    const f = Object.values(u.formats ?? {});
    return f.length && f.every(x => x === 'absent') && v['fp16:vector'] != null ? 'fp16:vector' : null;
  };
  const shown = model.UNITS.filter(u => u.memoryBandwidthGBs && keyOf(u));
  const inChart = shown.filter(u => u.compute.unofficial?.includes(keyOf(u))).length;
  const cap = await text('#scatterCap', p);
  check('the chart says how many of its points are unofficial', inChart > 0 && cap.includes(`${inChart} of the figures are unofficial`), cap);
  // A card with no matrix units is on the chart at its vector rate, drawn as a ring.
  const vec = shown.filter(u => keyOf(u) === 'fp16:vector');
  const drawn = await p.evaluate(() => Chart.getChart('scatterChart').data.datasets.flatMap(d => d.data).filter(x => x.vector).map(x => x.label));
  check('matrix-less cards are plotted at their vector rate', vec.length > 0 && drawn.length === vec.length && vec.every(u => drawn.includes(u.label)) && cap.includes(`${vec.length} at a vector rate`), `${drawn.join(', ')} | ${cap}`);
  await p.close();
}

// The PCIe host-link slider and the form-factor chips.
{
  const p = await browser.newPage();
  const names = () => p.locator('#hwTable tbody tr > td:first-child > span:first-child').allTextContents();
  await p.goto(`${base}/index.html#host=60`, { waitUntil: 'networkidle' });
  const fast = await names();
  const wantFast = model.UNITS.filter(u => u.hostGBs >= 60).length;
  check('a host-link minimum keeps the PCIe 5.0 x16 and faster cards', fast.length === wantFast && wantFast > 0 && !fast.some(l => /RTX 4090|Mac Studio/.test(l)), `${fast.length} rows for ${wantFast}`);
  check('and says integrated GPUs drop out', /integrated GPUs drop out/.test(await text('#hwSummary', p)));
  await p.goto(`${base}/index.html#ffoff=PCIe,integrated`, { waitUntil: 'networkidle' });
  const modules = await names();
  check('hiding PCIe cards and integrated GPUs leaves the SXM, OAM and MPX modules', modules.length === model.UNITS.filter(u => ['SXM', 'OAM', 'MPX'].includes(u.form)).length && modules.some(l => /H100 SXM/.test(l)) && modules.some(l => /MI300X/.test(l)) && modules.some(l => /Vega II Duo/.test(l)), modules.join(', '));
  const cell = await p.locator('#hwTable tbody tr', { hasText: 'H100 SXM' }).locator('td', { hasText: 'PCIe 5.0' }).first().textContent();
  check('the table gives form factor and host link', /SXM5\s*PCIe 5\.0 ×16 · 63 GB\/s/.test(cell ?? ''), cell);
  await p.close();
}

// Cards joined without PCIe: "2+" means any direct link at all.
{
  const p = await browser.newPage();
  const rowsAt = async n => {
    await p.goto(`${base}/index.html#link=${n}`, { waitUntil: 'networkidle' });
    return p.locator('#hwTable tbody tr > td:first-child > span:first-child').allTextContents();
  };
  const two = await rowsAt(2);
  const want2 = model.UNITS.filter(u => u.link >= 2).length;
  check('the 2+ link filter keeps exactly the linked cards', two.length === want2, `${two.length} rows for ${want2} linked units`);
  check('2+ keeps a bridged pair and drops unlinked cards', two.includes('GeForce RTX 3090 24GB') && !two.some(l => /A770|PG199/.test(l)), two.join(', '));
  const four = await rowsAt(4);
  check('4+ keeps the 4-card hives and drops the pairs', four.some(l => /MI100/.test(l)) && four.some(l => /Max 1100/.test(l)) && !four.some(l => /RTX 3090/.test(l)), four.join(', '));
  check('the link filter is in the summary', /cards joined without PCIe/.test(await text('#hwSummary', p)));
  // A range matches any group size a card supports: exactly 2 keeps bridge pairs
  // and cards whose smaller options include a pair, not 4-only hives or 8-GPU boards.
  await p.goto(`${base}/index.html#link=2&linkmax=2`, { waitUntil: 'networkidle' });
  const pairs = await p.locator('#hwTable tbody tr > td:first-child > span:first-child').allTextContents();
  const wantPairs = model.UNITS.filter(u => u.linkSizes?.includes(2)).length;
  check('exactly 2 cards keeps every card that can pair', pairs.length === wantPairs && pairs.includes('GeForce RTX 3090 24GB') && pairs.some(l => /V100 SXM2/.test(l)) && !pairs.some(l => /MI100|H100 SXM/.test(l)), pairs.join(', '));
  await p.goto(`${base}/index.html#link=5&linkmax=6`, { waitUntil: 'networkidle' });
  const six = await p.locator('#hwTable tbody tr > td:first-child > span:first-child').allTextContents();
  check('5 to 6 cards finds the AC922\'s six-GPU V100s', six.length === model.UNITS.filter(u => u.linkSizes?.some(n => n >= 5 && n <= 6)).length && six.some(l => /V100 SXM2/.test(l)), six.join(', '));
  await p.close();
}

// The question this section exists for: FP8 matrix units and more than 1 TiB/s,
// typed exactly into the bandwidth slider's minimum box.
await page.click('#fmtChips button:has-text("FP8")');
await setBox('#bwRange .lo-num', 1099.511627776);
await settle();
{
  const want = expectMatch({ fmt: new Set(['fp8']), bwMin: 1099.511627776 }).sort();
  const got = (await hwLabels()).sort();
  check('FP8 + 1 TiB/s lists exactly the matching units', JSON.stringify(got) === JSON.stringify(want), `got ${got.join(', ')}; want ${want.join(', ')}`);
  check('the query found something', want.length > 0);
  check('an Ampere card is not an FP8 match', !got.some(l => /3090|A6000|A100/.test(l)), got.join(', '));
  check('the MI300X family is an FP8 match', ['AMD Instinct MI300X 192GB', 'AMD Instinct MI325X 256GB', 'AMD Instinct MI355X 288GB'].every(l => got.includes(l)), got.join(', '));
  check('the 4090 clears 1 TB/s but not 1 TiB/s', !got.some(l => /4090/.test(l)));
  const hash = await page.evaluate(() => location.hash);
  check('the filter is kept in the address', /fmt=fp8/.test(hash) && /bw=1099/.test(hash), hash);
  check('the chart follows the format asked for', /FP8/.test(await text('#scatterCap')));
  check('the summary names 1 TiB/s', /1 TiB\/s/.test(await text('#hwSummary')), await text('#hwSummary'));
  check('the box shows the bound to one decimal', (await page.locator('#bwRange .lo-num').inputValue()) === '1099.5');
  // Editing the other end must not round the exact bound already typed here.
  await setBox('#bwRange .hi-num', 9000);
  await setBox('#bwRange .hi-num', '');
  check('the exact bound survives an edit to the other end', /bw=1099\.511627776/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
  const lo = Number(await page.locator('#bwRange input.lo').inputValue());
  check('the slider handle moved to match the typed bound', lo > 60 && lo < 140, `position ${lo}`);
}
// Switching tabs is a view change, not a reset: filters and settings carry over.
{
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html#fmt=fp8&bw=1000&model=gemma4_31b&d=65536`, { waitUntil: 'networkidle' });
  const before = await text('#hwSummary', p2);
  await openTab('ceilings', p2);
  check('a tab switch keeps the filters', (await text('#hwSummary', p2)) === before, `${before} -> ${await text('#hwSummary', p2)}`);
  check('a tab switch keeps the calculator settings', (await p2.locator('#modelSelect').inputValue()) === 'gemma4_31b' && (await text('#depthSlider output', p2)) === '64K');
  const h = await p2.evaluate(() => location.hash);
  check('and the view, tab included, stays in the address', /fmt=fp8/.test(h) && /tab=ceilings/.test(h), h);
  check('the ceilings tab says which hardware filters scope it', /match the Hardware tab's filters/.test(await text('#ceilScope', p2)));
  await p2.click('#ceilScope a[data-tab="hardware"]');
  await p2.waitForTimeout(60);
  check('and links back to them', await p2.locator('#hardware').isVisible() && !(await p2.locator('#ceilings').isVisible()));
  await p2.close();
}
// One tab at a time, the shared settings only where they apply, and every old anchor still lands.
{
  const tabs = await page.$$eval('[role="tab"]', b => b.map(x => x.dataset.tab));
  check('six tabs, one panel showing', tabs.length === 6 && (await page.locator('[role="tabpanel"]:visible').count()) === 1, tabs.join(','));
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  const shows = {};
  for (const t of tabs) {
    await openTab(t, p2);
    shows[t] = await p2.locator('#sharedSettings').isVisible();
  }
  check('the shared settings show on Ceilings, Rigs and the frontier only', JSON.stringify(shows) === JSON.stringify({ hardware: false, ceilings: true, observations: false, rigs: true, frontier: true, method: false }), JSON.stringify(shows));
  await p2.focus('[role="tab"][data-tab="method"]');
  await p2.keyboard.press('ArrowRight');
  check('arrow keys move between tabs and wrap', await p2.locator('#hardware').isVisible());
  await p2.goto(`${base}/index.html#tab=rigs&w=q8_0`, { waitUntil: 'networkidle' });
  check('a link with a tab opens it', await p2.locator('#rigs').isVisible() && !(await p2.locator('#hardware').isVisible()));
  for (const [anchor, tab] of [['#frontier', 'frontier'], ['#carriers', 'rigs'], ['#carrier-aom_sxmv', 'rigs'], ['#systems', 'rigs'], ['#carrier-dgx2', 'rigs'], ['#method', 'method']]) {
    const p3 = await browser.newPage();
    await p3.goto(`${base}/index.html${anchor}`, { waitUntil: 'networkidle' });
    check(`an old anchor (${anchor}) opens its tab`, await p3.locator(`#${tab}`).isVisible());
    await p3.close();
  }
  await p2.close();
  // On a phone the tab bar scrolls sideways; the open tab stays in it, and a
  // switch from deep in one tab starts the next at its top.
  const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await phone.goto(`${base}/index.html#tab=frontier`, { waitUntil: 'networkidle' });
  await phone.waitForTimeout(300);
  const inBar = await phone.evaluate(() => {
    const b = document.getElementById('tab-frontier').getBoundingClientRect();
    const bar = document.querySelector('[role="tablist"]').getBoundingClientRect();
    return b.left >= bar.left - 1 && b.right <= bar.right + 1;
  });
  check('on a phone the open tab is scrolled into the tab bar', inBar);
  await phone.evaluate(() => window.scrollTo(0, 3000));
  await phone.click('[role="tab"][data-tab="method"]');
  await phone.waitForTimeout(150);
  const top = await phone.evaluate(() => document.querySelector('#method h2').getBoundingClientRect().top);
  check('a tab switch from deep in a tab lands at the new tab\'s top', top >= 0 && top < 400, `heading at ${Math.round(top)}px`);
  check('no sideways scroll on a phone', (await phone.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await phone.close();
}
// Hand-written addresses with odd values degrade, never blank the page.
for (const [hash, what, test] of [
  ['#sort=fmts:asc', 'a sort key with no column', async p => (await p.locator('#loadError').isHidden()) && (await count('#hwTable tbody tr', p)) === model.UNITS.length],
  ['#d=300', 'a depth below the scale clamps to 1K', async p => (await text('#depthSlider output', p)) === '1K'],
  ['#bw=2000&bwmax=500', 'a reversed range from an address', async p => /500[^,]*–2,000/.test(await text('#hwSummary', p))],
]) {
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html${hash}`, { waitUntil: 'networkidle' });
  check(`${what} (${hash})`, await test(p2), await text('#hwSummary', p2));
  await p2.close();
}
// The chart precision survives a reload even when a format filter would pick another.
{
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html#fmt=fp8`, { waitUntil: 'networkidle' });
  await p2.click('#scatterPrecChips button:has-text("FP16")');
  await p2.waitForTimeout(100);
  const hash = await p2.evaluate(() => location.hash);
  await p2.goto(`${base}/index.html${hash}`, { waitUntil: 'networkidle' });
  await p2.reload({ waitUntil: 'networkidle' });
  check('a chosen chart precision survives a reload', /FP16/.test(await text('#scatterCap', p2)), `${hash} -> ${await text('#scatterCap', p2)}`);
  await p2.close();
}
// The same query arriving as a link.
{
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html#fmt=fp8&bw=1000`, { waitUntil: 'networkidle' });
  const want = expectMatch({ fmt: new Set(['fp8']), bwMin: 1000 }).sort();
  const got = (await hwLabels(p2)).sort();
  check('a shared link restores the filter', JSON.stringify(got) === JSON.stringify(want), `got ${got.length}, want ${want.length}`);
  check('at 1 TB/s the 4090 is in', got.some(l => /4090/.test(l)), got.join(', '));
  await p2.close();
}
await page.click('#hwReset');
await settle();
check('clearing filters lists every unit again', (await count('#hwTable tbody tr')) === model.UNITS.length);
{
  // A multi-GPU board: memory per GPU, price per board, $ per GB over the board.
  const a16 = model.UNITS.find(u => u.id === 'a16');
  const t = await page.locator('#hwTable tbody tr', { hasText: a16.label }).first().textContent();
  check('the A16 row shows per-GPU memory and a per-board price', /per GPU · 4 per board/.test(t) && t.includes(`${usd(a16.street)}`) && /per board/.test(t) && t.includes(usd(a16.street / (a16.memoryGB * a16.gpus))), t);
  // A board's direct link counts GPUs: the W6800X Duo's on-board pair, or two bridged modules.
  const w = model.UNITS.find(u => u.id === 'radeon_pro_w6800x_duo');
  const wt = await page.locator('#hwTable tbody tr', { hasText: w.label }).first().textContent();
  check('the W6800X Duo row is an MPX module whose link joins 2 or 4 GPUs', /MPX/.test(wt) && /2 or 4 GPUs/.test(wt), wt);
}
check('clearing filters empties the slider boxes', (await page.locator('#bwRange .lo-num').inputValue()) === '');

// A two-ended range: cards priced between $1,000 and $2,000.
{
  await setBox('#priceRange .lo-num', 1000);
  await setBox('#priceRange .hi-num', 2000);
  await settle();
  const want = expectMatch({ priceMin: 1000, priceMax: 2000 }).sort();
  const got = (await hwLabels()).sort();
  check('a min-max price range lists exactly the units inside it', JSON.stringify(got) === JSON.stringify(want), `got ${got.join(', ')}; want ${want.join(', ')}`);
  const hash = await page.evaluate(() => location.hash);
  check('both ends of a range are kept in the address', /pricemin=1000/.test(hash) && /price=2000/.test(hash), hash);
  // Reversed boxes are put the right way round rather than matching nothing.
  await setBox('#priceRange .lo-num', 2000);
  await setBox('#priceRange .hi-num', 1000);
  await settle();
  check('a reversed range is read the right way round', (await hwLabels()).length === want.length);
  // A bound typed at the very end of the scale is no bound at all.
  await setBox('#priceRange .hi-num', '');
  await setBox('#priceRange .lo-num', await page.locator('#priceRange .lo-num').getAttribute('min'));
  await settle();
  check('a minimum at the bottom of the scale is an open end', (await page.locator('#priceRange .lo-num').inputValue()) === '' && (await count('#hwTable tbody tr')) === model.UNITS.length);
  // An emptied box is an open end.
  await setBox('#priceRange .lo-num', '');
  await setBox('#priceRange .hi-num', '');
  await settle();
  check('emptying both boxes removes the bound', (await count('#hwTable tbody tr')) === model.UNITS.length);
}
// Moving a handle by keyboard narrows the list, and the box follows the handle.
{
  await page.focus('#memRange input.lo');
  for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowRight');
  await settle();
  const boxed = Number(await page.locator('#memRange .lo-num').inputValue());
  const want = expectMatch({ memMin: boxed }).length;
  check('a keyboard-moved handle fills its box with a round number', boxed > 0 && Number.isInteger(boxed), `box ${boxed}`);
  check('and the list matches that bound', (await count('#hwTable tbody tr')) === want && want < model.UNITS.length, `${await count('#hwTable tbody tr')} vs ${want}`);
  await page.click('#hwReset');
  await settle();
}

// Every vendor has its own colour, on its chip and on its chart points; a new
// vendor with no token would fall back to the muted mark and fail here.
{
  const vendors = [...new Set(model.UNITS.map(u => u.vendor ?? 'Other'))];
  const seen = await page.evaluate(() => {
    const mute = getComputedStyle(document.documentElement).getPropertyValue('--mute-mark').trim();
    const dots = [...document.querySelectorAll('#vendorChips button')].map(b => ({ v: b.textContent.trim(), c: b.querySelector('.vdot')?.style.getPropertyValue('--c') }));
    const c = Chart.getChart('scatterChart');
    const onDs = c.data.datasets.findIndex(d => d.labelPoints);
    const pts = c.getDatasetMeta(onDs).data.map((el, i) => ({ v: c.data.datasets[onDs].data[i].vendor, c: el.options.backgroundColor }));
    return { mute, dots, pts };
  });
  const colours = new Set(seen.dots.map(d => d.c));
  check('every vendor chip has its own colour', seen.dots.length === vendors.length && seen.dots.every(d => d.c && d.c !== seen.mute) && colours.size === vendors.length, JSON.stringify(seen.dots));
  const byVendor = new Map(seen.dots.map(d => [d.v, d.c]));
  check('chart points wear their vendor colour', seen.pts.length > 0 && seen.pts.every(p => p.c === byVendor.get(p.v)), JSON.stringify(seen.pts.filter(p => p.c !== byVendor.get(p.v)).slice(0, 3)));
}

// Vendor chips hide and restore.
{
  const nv = model.UNITS.filter(u => u.vendor === 'NVIDIA').length;
  await page.click('#vendorChips button:has-text("NVIDIA")');
  await settle();
  check('a vendor chip hides that vendor', (await count('#hwTable tbody tr')) === model.UNITS.length - nv);
  await page.focus('#vendorChips button:has-text("NVIDIA")');
  await page.keyboard.press('Enter');
  await settle();
  check('and brings it back', (await count('#hwTable tbody tr')) === model.UNITS.length);
  check('a pressed chip keeps keyboard focus', await page.evaluate(() => document.activeElement?.closest('#vendorChips') != null));
}

// Sorting: bandwidth descending is the default; a click reverses it, blanks last both ways.
// The leading number is the figure: a multi-GPU board's cell adds "per GPU".
{
  const bws = async () =>
    (await page.locator('#hwTable tbody tr td:nth-child(3)').allTextContents()).map(t => (t.trim() === '—' ? null : parseFloat(t.replace(/,/g, ''))));
  const isSorted = (xs, dir) => {
    const v = xs.filter(x => x != null);
    const blanksLast = xs.indexOf(null) === -1 || xs.slice(xs.indexOf(null)).every(x => x == null);
    return blanksLast && v.every((x, i) => i === 0 || (dir === 'desc' ? v[i - 1] >= x : v[i - 1] <= x));
  };
  check('bandwidth sorts high to low by default', isSorted(await bws(), 'desc'));
  await page.click('#hwTable th[data-sortkey="bw"]');
  await settle();
  check('a second click sorts low to high, blanks still last', isSorted(await bws(), 'asc'));
  await page.click('#hwTable th[data-sortkey="bw"]');
  await settle();
}

// "Not sourced" can be counted as a match when asked.
{
  const want = expectMatch({ fmt: new Set(['fp8']), fmtUnknownOk: true }).length;
  await page.click('#fmtChips button:has-text("FP8")');
  await page.check('#fmtUnknownOk');
  await settle();
  check('counting unsourced support as a match widens the list', (await count('#hwTable tbody tr')) === want);
  await page.click('#hwReset');
  await settle();
}

// --- 2. Ceilings -----------------------------------------------------------
await openTab('ceilings');
const withParams = Object.keys(MODELS).filter(id => MODELS[id].params?.active);
check('every model with a parameter count is selectable', (await count('#modelSelect option')) === withParams.length, `got ${await count('#modelSelect option')} of ${withParams.length}`);
check('model card rendered', /parameters/.test(await text('#modelCard')));
check('depth chart painted', await canvasPainted('depthChart'));
await page.click('#scopeChips button:has-text("All units")');
await settle();
{
  const rows = await count('#ceilTable tbody tr');
  const withBw = model.UNITS.filter(u => u.memoryBandwidthGBs).length;
  check('one ceiling row per unit with a bandwidth figure', rows === withBw, `got ${rows} of ${withBw}`);
  const t = await text('#ceilTable tbody');
  check('ceiling table renders no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
}

// The physics, through the UI: going from 4K to 256K costs a full-attention
// dense model far more decode ceiling than a hybrid with a quarter of its
// layers on full attention.
async function decodeAt(modelId, tokens) {
  await page.selectOption('#modelSelect', modelId);
  await setHandle('#depthSlider input', depthPos(tokens));
  await setCards(1);
  await settle();
  const row = page.locator('#ceilTable tbody tr', { hasText: 'RTX PRO 6000' }).first();
  return Number((await row.locator('.bar .v').first().textContent()).replace(/,/g, ''));
}
{
  const fullId = withParams.find(id => MODELS[id].layerTypes.linear_attention == null && MODELS[id].layerTypes.sliding_attention == null && MODELS[id].params.active === MODELS[id].params.total);
  const hybridId = withParams.find(id => MODELS[id].layerTypes.linear_attention > 0);
  const f4 = await decodeAt(fullId, 4096);
  const f256 = await decodeAt(fullId, 262144);
  const h4 = await decodeAt(hybridId, 4096);
  const h256 = await decodeAt(hybridId, 262144);
  check('the depth readout names the depth', (await text('#depthSlider output')) === '256K', await text('#depthSlider output'));
  // Qwen3-32B's window is 40,960 tokens; 256K is past it.
  await decodeAt('qwen3_32b', 262144);
  check('a depth past the model\'s context window is flagged', /beyond Qwen3-32B/.test(await text('#ceilNote')), await text('#ceilNote'));
  check(`decode ceiling falls with depth (${fullId})`, f256 < f4, `${f4} -> ${f256}`);
  check(`a hybrid keeps more of its ceiling than a full-attention model (${hybridId} vs ${fullId})`, h256 / h4 > f256 / f4, `${(h256 / h4).toFixed(2)} vs ${(f256 / f4).toFixed(2)}`);
  await setCards('auto');
  await setHandle('#depthSlider input', depthPos(131072));
  await page.selectOption('#modelSelect', 'qwen38_27b');
  await settle();
  check('depth comes back to 128K', (await text('#depthSlider output')) === '128K');
  check('the card slider is disabled while the fewest-that-fit box decides', await page.locator('#cardSlider input').isDisabled() && (await text('#cardSlider output')) === 'fewest');
}
{
  // Tensor parallel multiplies a single stream's bandwidth; a layer split does not.
  await page.selectOption('#modelSelect', withParams.find(id => MODELS[id].params.total > 60e9) ?? 'qwen38_27b');
  await setCards(4);
  await page.click('#splitChips button:has-text("Tensor parallel")');
  await settle();
  const row = () => page.locator('#ceilTable tbody tr', { hasText: 'RTX 3090 24GB' }).first().locator('.bar .v').first();
  const tp = Number((await row().textContent()).replace(/,/g, ''));
  await page.click('#splitChips button:has-text("Layer split")');
  await settle();
  const layer = Number((await row().textContent()).replace(/,/g, ''));
  check('four cards under tensor parallel get four cards of bandwidth', Math.abs(tp / layer - 4) < 0.01, `${tp} vs ${layer}`);
  // Three cards is a count the old buttons could not ask for.
  await page.click('#splitChips button:has-text("Tensor parallel")');
  await setCards(3);
  await settle();
  const three = Number((await row().textContent()).replace(/,/g, ''));
  check('a three-card tensor-parallel split gets three cards of bandwidth', Math.abs(three / layer - 3) < 0.01, `${three} vs ${layer}`);
  // The A16's GPUs are counted one by one but bought four to a board.
  const a16 = model.UNITS.find(u => u.id === 'a16');
  const a16Row = async n => {
    await setCards(n);
    await settle();
    return page.locator('#ceilTable tbody tr', { hasText: a16.label }).first().textContent();
  };
  const four = await a16Row(4);
  const five = await a16Row(5);
  check('four A16 GPUs cost one board, five cost two', four.includes(usd(a16.street)) && /GPUs on 1 board/.test(four) && five.includes(usd(2 * a16.street)) && /GPUs on 2 boards/.test(five), `${four} | ${five}`);
  await setCards('auto');
  await page.selectOption('#modelSelect', 'qwen38_27b');
  await page.click('#scopeChips button:has-text("Matching the hardware filters")');
  await settle();
}

// --- 3. Observations -------------------------------------------------------
await openTab('observations');
check('one group per serving line', (await count('#obsTable tr.line-head')) === model.LINES.length, `got ${await count('#obsTable tr.line-head')} of ${model.LINES.length}`);
check('one row per reading', (await count('#obsTable tr.pt')) === totalPoints, `got ${await count('#obsTable tr.pt')} of ${totalPoints}`);
{
  const t = await text('#obsTable tbody');
  check('observations render no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
  check('ranges render as ranges', /129\.3–131\.3/.test(t), 'expected the Ada top rung 10K decode range');
  check('every first-party line is attested', (await count('#obsTable .prov.witnessed')) === model.LINES.filter(l => l.provenance.attestation === 'witnessed').length);
  check('readings with no depth say so', (t.match(/depth not recorded/g) ?? []).length >= model.LINES.reduce((n, l) => n + l.points.filter(p => p.depth == null).length, 0));
  const shares = await count('#obsTable tr.pt .bar');
  const expected = model.LINES.reduce((n, l) => n + l.points.filter(p => p.ratio != null).length, 0);
  check('every reading with a ceiling shows its share', shares === expected, `got ${shares} of ${expected}`);
  check('some readings can be compared', expected > 0);
}
{
  await page.selectOption('#obsDevice', 'rtx_3090');
  await settle();
  const want = model.LINES.filter(l => l.rig.units.some(u => u.unit === 'rtx_3090')).length;
  check('the device filter narrows to that device', (await count('#obsTable tr.line-head')) === want, `got ${await count('#obsTable tr.line-head')} of ${want}`);
  await page.click('#obsMetricChips button:has-text("Prefill")');
  await settle();
  check('the metric filter leaves only prefill readings', (await page.locator('#obsTable tr.pt td:first-child').allTextContents()).every(t => t.startsWith('Prefill')));
  await page.selectOption('#obsDevice', '');
  await page.click('#obsMetricChips button:has-text("All")');
  await settle();
}

// "With speculation" drops exactly the decode readings taken without it, and no prefill.
{
  const specOn = (l, p) => !!l.spec && l.spec.method !== 'none' && p.spec !== 'off';
  const want = model.LINES.reduce((n, l) => n + l.points.filter(p => p.metric !== 'decode' || specOn(l, p)).length, 0);
  const wantDecode = model.LINES.reduce((n, l) => n + l.points.filter(p => p.metric === 'decode' && specOn(l, p)).length, 0);
  await page.click('#obsSpecChips button:has-text("With speculation")');
  await settle();
  const rows = await page.locator('#obsTable tr.pt td:first-child').allTextContents();
  check('the speculation filter keeps spec-on decode and all prefill', rows.length === want && rows.filter(t => t.startsWith('Decode')).length === wantDecode && wantDecode > 0, `${rows.length} rows for ${want}`);
  check('and it is in the address', /ospec=on/.test(await page.evaluate(() => location.hash)));
  await page.click('#obsSpecChips button:has-text("All")');
  await settle();
}

{
  await page.selectOption('#obsModel', '__none');
  await settle();
  const want = model.LINES.filter(l => l.model == null).length;
  check('"Not recorded" isolates the lines with no model', (await count('#obsTable tr.line-head')) === want, `got ${await count('#obsTable tr.line-head')} of ${want}`);
  await page.selectOption('#obsModel', '');
  await settle();
  const withdrawn = model.LINES.filter(l => l.status === 'withdrawn').length;
  check('withdrawn lines stay visible and say so', (await page.locator('#obsTable tr.line-head .t-bad', { hasText: 'withdrawn' }).count()) === withdrawn && withdrawn > 0);
}

// --- 4. Rigs ---------------------------------------------------------------
await openTab('rigs');
check('one row per candidate rig, each with its notes beneath', (await count('#candTable tbody tr.cand-main')) === model.CANDIDATES.length && (await count('#candTable tbody tr.cand-notes')) === model.CANDIDATES.length);
{
  const t = await text('#candTable tbody');
  check('the MI100 rig totals its cards and bridge as a range', /\$4,250–\$4,800/.test(t), 'expected 4 x $900 + $650-$1,200');
  check('the Max pair totals cards plus a $0-$70 bridge', /\$4,000–\$4,070/.test(t), 'expected 2 x $2,000 + $0-$70');
  check('the V100 rig totals cards and its carrier', /\$3,960\s*cards \+ carrier/.test(t), 'expected 4 x $790 + $800 for the 1CATai board');
  check('rigs on one carrier share its price: board plus host cables', /\$4,500–\$4,575/.test(t) && /\$7,340–\$7,415/.test(t), 'expected 4 x $790 or 4 x $1,500, plus $1,300 and $40-$115');
  check('a module without NVLink meets its peers over PCIe, by the carrier\'s switches', /PCIe peers meet inside a switch in groups of 2, through the host between groups/.test(t) && /PCIe peer path not recorded/.test(t));
  check('each rig on a carrier shows the fit of its modules', /PG199 \/ DRIVE A100: untested on this carrier/.test(t) && /PG199 \/ DRIVE A100: verified on this carrier/.test(t));
  check('carrier rigs link to their carrier', (await count('#candTable tbody a[href^="#carrier-"]')) === model.CANDIDATES.filter(c => c.rig.carrier).length);
  check('peer bandwidth is shown where the vendor states it', /300 GB\/s/.test(t) && /276 GB\/s/.test(t));
  check('a missing peer bandwidth says so', /not stated/.test(t));
  check('host requirements are shown with each candidate', (t.match(/Host:/g) ?? []).length === model.CANDIDATES.length);
  check('rig sources render as links', (await count('#candTable tbody tr.cand-notes a[href^="https://"]')) >= model.CANDIDATES.filter(c => c.sources?.length).length && (await count('#candTable tbody tr.cand-notes a[href*="rexyuan.com"]')) >= 1);
  check('each rig shows ceilings for its models', (t.match(/TP decode/g) ?? []).length === model.CANDIDATES.reduce((n, c) => n + c.models.length, 0));
  check('rigs render no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
}

// --- 5. Open-weight frontier ------------------------------------------------
await openTab('frontier');
check('frontier chart painted once its tab opens', await canvasPainted('frontierChart'));
check('one frontier row per scored open model', (await count('#frontierTable tbody tr')) === model.FRONTIER.length && model.FRONTIER.length > 0);
{
  const t = await text('#frontierTable tbody');
  const cap = await text('#frontierCap');
  const note = await text('#frontierNote');
  check('every scored open model is either on the frontier or says what beats it', (t.match(/on the frontier|beaten by/g) ?? []).length >= model.FRONTIER.length);
  check('the frontier names its index, version and source, with the attribution', /Intelligence Index/.test(cap) && /v\d/.test(cap) && (await count('#frontierCap a[href^="https://artificialanalysis.ai"]')) === 1 && /Artificial Analysis/.test(note));
  check('a model too big for every rig says so', /no rig here/.test(t));
  check('the frontier renders no NaN/undefined/null', !BROKEN.test(t + cap), brokenAt(t + cap));
}

// --- 4b. Carriers ----------------------------------------------------------
await openTab('rigs');
const BOARDS = model.CARRIERS.filter(k => k.kind !== 'system');
const SYSTEMS = model.CARRIERS.filter(k => k.kind === 'system');
check('one row per carrier, each with its notes beneath', (await count('#carrierTable tbody tr.cand-main')) === BOARDS.length && (await count('#carrierTable tbody tr.cand-notes')) === BOARDS.length && BOARDS.length > 0);
{
  const t = await text('#carrierTable tbody');
  check('carrier host links are per GPU, shared per uplink', /16 GB\/s\s*Gen 3 x16, shared by 2/.test(t) && /32 GB\/s\s*Gen 3 x16/.test(t));
  check('every carrier lists what fits in it', (t.match(/verified|reported|untested|fails/g) ?? []).length >= BOARDS.reduce((n, k) => n + k.fits.length, 0));
  check('a carrier price says what it includes', /\$1,300\s*the board alone/.test(t) && /\+ \$40–\$115 parts/.test(t));
  check('carriers render no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
}
check('systems get their own table, one row each with notes', (await count('#systemTable tbody tr.cand-main')) === SYSTEMS.length && (await count('#systemTable tbody tr.cand-notes')) === SYSTEMS.length && SYSTEMS.length > 0);
{
  const t = await text('#systemTable tbody');
  check('a system shows its host CPU and memory', /E5-2698 v4/.test(t) && /512 GB host memory/.test(t) && /up to 8,192 GB host memory/.test(t));
  check('a system shows its maximum power, or says it is not recorded', /3,500 W/.test(t) && /10,000 W/.test(t) && /not recorded/.test(t));
  check('a system priced with its modules says so', /\$16,500/.test(t) && /GPUs included: 8× Intel Gaudi 2/.test(t));
  check('Gaudi peers meet over Ethernet, all-to-all', /Ethernet \(RoCE\)/.test(t) && /525 GB\/s per GPU/.test(t));
  check('the DGX-2 host link is shared by four GPUs', /8 GB\/s\s*Gen 3 x16, shared by 4/.test(t));
  check('systems render no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
  check('a system rig links to its system', (await count('#candTable tbody a[href="#carrier-dgx1_v100"]')) === 1);
  const c = await text('#candTable tbody');
  check('a system rig does not pay for its bundled GPUs again', /\$16,500\s*system, GPUs included/.test(c), 'expected the $16,499.99 server, not plus 8 x $2,500');
  check('a system rig shows the host it comes with', /Built in: 2× Intel Xeon E5-2698 v4/.test(c));
}

check('still no console or page errors after every interaction', consoleErrors.length === 0, consoleErrors.join(' | '));

// --- Data the page has not seen before -------------------------------------
// Rewriting the response on the way in, rather than parking speculative
// numbers in the real data file.
async function withPatchedData(patch, hash = '') {
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => m.type() === 'error' && ours(m.location()?.url) && errs.push(m.text()));
  await p.route('**/compendium.json', async route => {
    const res = await route.fetch();
    const d = JSON.parse(await res.text());
    patch(d);
    await route.fulfill({ response: res, body: JSON.stringify(d), headers: { 'content-type': 'application/json' } });
  });
  await p.goto(`${base}/index.html${hash}`, { waitUntil: 'networkidle' });
  return { p, errs };
}

// A new card from an existing generation inherits its formats with no code change.
{
  const { p, errs } = await withPatchedData(d => {
    d.units.push({ id: 'test_card', label: 'Test Accelerator 64GB', vendor: 'NVIDIA', arch: 'hopper', memoryGB: 64, memoryBandwidthGBs: 3000, sources: ['test fixture'] });
  }, '#fmt=fp8&bw=2500');
  const got = await hwLabels(p);
  check('a new card inherits FP8 from its generation', got.includes('Test Accelerator 64GB'), got.join(', '));
  check('a card with no rated figures still renders', errs.length === 0, errs.join(' | '));
  await p.close();
}
// A card with no generation at all degrades to "not sourced", not a crash.
{
  const { p, errs } = await withPatchedData(d => {
    d.units.push({ id: 'blank_card', label: 'Blank Accelerator' });
  });
  check('a card carrying only a name renders', errs.length === 0 && (await count('#hwTable tbody tr', p)) === model.UNITS.length + 1, errs.join(' | '));
  await p.close();
}
// A reading above its ceiling is drawn as one, not clipped into looking fine.
{
  const { p } = await withPatchedData(d => {
    const l = d.lines.find(x => x.id === 'x_5090_qwen3_32b_llamacpp');
    l.results.find(r => r.metric === 'decode' && r.depth === 32768).value = 900;
  });
  check('an impossible reading is flagged over its ceiling', (await count('#obsTable .fill.over', p)) >= 1);
  await p.close();
}
// A unit naming a generation that does not exist surfaces a readable error.
{
  const { p } = await withPatchedData(d => {
    d.units[0].arch = 'nosuchgen';
  });
  const banner = await p.locator('#loadError').textContent();
  check('a bad generation reference surfaces an error banner', /unknown architecture/.test(banner), banner.slice(0, 120));
  await p.close();
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`✗ smoke test — ${problems.length} of ${checks.length} checks failed:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ smoke test — ${checks.length} checks passed`);
