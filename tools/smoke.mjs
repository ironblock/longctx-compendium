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
const NO_FILTER = { fmt: new Set(), fmtUnknownOk: false, bw: null, mem: null, price: null, vendorsOff: new Set() };
const expectMatch = filter => model.UNITS.filter(u => unitMatch(u, { ...NO_FILTER, ...filter }).ok).map(u => u.label);
const totalPoints = model.LINES.reduce((n, l) => n + l.points.length, 0);
// A failed number renders as one of these. "Infinity Fabric" is AMD's interconnect, not a division by zero.
const BROKEN = /\bNaN\b|\bundefined\b|\bnull\b|Infinity(?! Fabric)/;
const brokenAt = t => t.match(new RegExp(`.{0,30}(${BROKEN.source}).{0,30}`))?.[0];

const text = async (sel, p = page) => (await p.locator(sel).first().textContent())?.trim() ?? '';
const count = async (sel, p = page) => await p.locator(sel).count();
const canvasPainted = async (id, p = page) =>
  await p.evaluate(sel => {
    const c = document.querySelector(sel);
    if (!c || !c.width || !c.height) return false;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
    return false;
  }, `#${id}`);
const settle = () => page.waitForTimeout(60);
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

// The question this section exists for: FP8 matrix units and more than 1 TiB/s.
await page.click('#fmtChips button:has-text("FP8")');
await page.click('#bwChips button:has-text("1 TiB/s")');
await settle();
{
  const want = expectMatch({ fmt: new Set(['fp8']), bw: 1099.511627776 }).sort();
  const got = (await hwLabels()).sort();
  check('FP8 + 1 TiB/s lists exactly the matching units', JSON.stringify(got) === JSON.stringify(want), `got ${got.join(', ')}; want ${want.join(', ')}`);
  check('the query found something', want.length > 0);
  check('an Ampere card is not an FP8 match', !got.some(l => /3090|A6000|A100/.test(l)), got.join(', '));
  check('the 4090 clears 1 TB/s but not 1 TiB/s', !got.some(l => /4090/.test(l)));
  const hash = await page.evaluate(() => location.hash);
  check('the filter is kept in the address', /fmt=fp8/.test(hash) && /bw=1099/.test(hash), hash);
  check('the chart follows the format asked for', /FP8/.test(await text('#scatterCap')));
}
// The same query arriving as a link.
{
  const p2 = await browser.newPage();
  await p2.goto(`${base}/index.html#fmt=fp8&bw=1000`, { waitUntil: 'networkidle' });
  const want = expectMatch({ fmt: new Set(['fp8']), bw: 1000 }).sort();
  const got = (await hwLabels(p2)).sort();
  check('a shared link restores the filter', JSON.stringify(got) === JSON.stringify(want), `got ${got.length}, want ${want.length}`);
  check('at 1 TB/s the 4090 is in', got.some(l => /4090/.test(l)), got.join(', '));
  await p2.close();
}
await page.click('#hwReset');
await settle();
check('clearing filters lists every unit again', (await count('#hwTable tbody tr')) === model.UNITS.length);

// Vendor chips hide and restore.
{
  const nv = model.UNITS.filter(u => u.vendor === 'NVIDIA').length;
  await page.click('#vendorChips button:has-text("NVIDIA")');
  await settle();
  check('a vendor chip hides that vendor', (await count('#hwTable tbody tr')) === model.UNITS.length - nv);
  await page.click('#vendorChips button:has-text("NVIDIA")');
  await settle();
  check('and brings it back', (await count('#hwTable tbody tr')) === model.UNITS.length);
}

// Sorting: bandwidth descending is the default; a click reverses it, blanks last both ways.
{
  const bws = async () =>
    (await page.locator('#hwTable tbody tr td:nth-child(3)').allTextContents()).map(t => (t.trim() === '—' ? null : Number(t.replace(/,/g, ''))));
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
async function decodeAt(modelId, depthLabel) {
  await page.selectOption('#modelSelect', modelId);
  await page.click(`#depthChips button:text-is("${depthLabel}")`);
  await page.click('#cardChips button:text-is("1")');
  await settle();
  const row = page.locator('#ceilTable tbody tr', { hasText: 'RTX PRO 6000' }).first();
  return Number((await row.locator('.bar .v').first().textContent()).replace(/,/g, ''));
}
{
  const fullId = withParams.find(id => MODELS[id].layerTypes.linear_attention == null && MODELS[id].layerTypes.sliding_attention == null && MODELS[id].params.active === MODELS[id].params.total);
  const hybridId = withParams.find(id => MODELS[id].layerTypes.linear_attention > 0);
  const f4 = await decodeAt(fullId, '4K');
  const f256 = await decodeAt(fullId, '256K');
  const h4 = await decodeAt(hybridId, '4K');
  const h256 = await decodeAt(hybridId, '256K');
  check(`decode ceiling falls with depth (${fullId})`, f256 < f4, `${f4} -> ${f256}`);
  check(`a hybrid keeps more of its ceiling than a full-attention model (${hybridId} vs ${fullId})`, h256 / h4 > f256 / f4, `${(h256 / h4).toFixed(2)} vs ${(f256 / f4).toFixed(2)}`);
  await page.click('#cardChips button:has-text("Fewest that fit")');
  await page.click(`#depthChips button:text-is("128K")`);
  await page.selectOption('#modelSelect', 'qwen38_27b');
  await settle();
}
{
  // Tensor parallel multiplies a single stream's bandwidth; a layer split does not.
  await page.selectOption('#modelSelect', withParams.find(id => MODELS[id].params.total > 60e9) ?? 'qwen38_27b');
  await page.click('#cardChips button:text-is("4")');
  await page.click('#splitChips button:has-text("Tensor parallel")');
  await settle();
  const row = () => page.locator('#ceilTable tbody tr', { hasText: 'RTX 3090 24GB' }).first().locator('.bar .v').first();
  const tp = Number((await row().textContent()).replace(/,/g, ''));
  await page.click('#splitChips button:has-text("Layer split")');
  await settle();
  const layer = Number((await row().textContent()).replace(/,/g, ''));
  check('four cards under tensor parallel get four cards of bandwidth', Math.abs(tp / layer - 4) < 0.01, `${tp} vs ${layer}`);
  await page.click('#splitChips button:has-text("Tensor parallel")');
  await page.click('#cardChips button:has-text("Fewest that fit")');
  await page.selectOption('#modelSelect', 'qwen38_27b');
  await page.click('#scopeChips button:has-text("Matching section 1")');
  await settle();
}

// --- 3. Observations -------------------------------------------------------
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

// --- 4. Rigs ---------------------------------------------------------------
check('one row per candidate rig, each with its notes beneath', (await count('#candTable tbody tr.cand-main')) === model.CANDIDATES.length && (await count('#candTable tbody tr.cand-notes')) === model.CANDIDATES.length);
{
  const t = await text('#candTable tbody');
  check('the MI100 rig totals its cards and bridge as a range', /\$4,250–\$4,800/.test(t), 'expected 4 x $900 + $650-$1,200');
  check('the Max pair totals cards plus a $0-$70 bridge', /\$4,000–\$4,070/.test(t), 'expected 2 x $2,000 + $0-$70');
  check('the V100 rig totals cards and board', /\$3,600/.test(t) && /cards \+ bridge\/board/.test(t), 'expected 4 x $700 + $800');
  check('peer bandwidth is shown where the vendor states it', /300 GB\/s/.test(t) && /276 GB\/s/.test(t));
  check('a missing peer bandwidth says so', /not stated/.test(t));
  check('host requirements are shown with each candidate', (t.match(/Host:/g) ?? []).length === model.CANDIDATES.length);
  check('each rig shows ceilings for its models', (t.match(/TP decode/g) ?? []).length === model.CANDIDATES.reduce((n, c) => n + c.models.length, 0));
  check('rigs render no NaN/undefined/null', !BROKEN.test(t), brokenAt(t));
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
