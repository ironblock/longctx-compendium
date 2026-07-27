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

await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });

const text = async sel => (await page.locator(sel).textContent())?.trim() ?? '';
const count = async sel => await page.locator(sel).count();

check('no console or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('error banner stays hidden', await page.locator('#loadError').isHidden());

// Confidence tally is computed from the data, so em dashes mean load failed.
for (const id of ['cMeasured', 'cExtrap', 'cModeled', 'cArch']) {
  const v = await text(`#${id}`);
  check(`confidence tally #${id} populated`, /^\d+$/.test(v), `got "${v}"`);
}

// 9 platforms x 3 archetypes + 4 group header rows.
check('prefill table rows', (await count('#ppTable tbody tr')) === 31, `got ${await count('#ppTable tbody tr')}`);
check('decode table rows', (await count('#tgTable tbody tr')) === 13, `got ${await count('#tgTable tbody tr')}`);
// 15 catalog units + 4 vendor group headers
check('spec table rows', (await count('#specTable tbody tr')) === 19, `got ${await count('#specTable tbody tr')}`);
check('value table rows', (await count('#valTable tbody tr')) === 9, `got ${await count('#valTable tbody tr')}`);
check('legend entries', (await count('#pleg span')) >= 9);
check('verdict rendered', (await text('#verdict')).length > 80);
check('value verdict rendered', (await text('#valVerdict')).length > 80);
check('spec units note rendered', (await text('#specUnits')).length > 20);

const canvasPainted = async id =>
  await page.evaluate(sel => {
    const c = document.querySelector(sel);
    if (!c || !c.width || !c.height) return false;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
    return false;
  }, `#${id}`);

check('prefill chart painted', await canvasPainted('ppChart'));

// Every toggle in every combination, asserting the page survives each click.
for (const [group, ids] of [
  ['#archTg', ['moe', 'dense', 'oss120b']],
  ['#viewTg', ['pp', 'tg', 'wc']],
  ['#valModelTg', ['tg120', 'tgMoe']],
  ['#valPowerTg', ['load', 'idle']],
]) {
  for (const v of ids) {
    const before = consoleErrors.length;
    await page.locator(`${group} button[data-${group === '#archTg' ? 'a' : group === '#viewTg' ? 'v' : group === '#valModelTg' ? 'vm' : 'vp'}="${v}"]`).click();
    await page.waitForTimeout(120);
    check(`${group} → ${v} renders cleanly`, consoleErrors.length === before, consoleErrors.slice(before).join(' | '));
  }
}

// Back to the default view, then confirm the chart repainted rather than
// leaving a dead canvas behind.
await page.locator('#viewTg button[data-v="pp"]').click();
await page.waitForTimeout(150);
check('prefill chart repainted after view cycling', await canvasPainted('ppChart'));

// --- Extensibility checks --------------------------------------------------
// The point of the data format is that new fields and half-filled devices work
// without code changes. Prove it by rewriting the response on the way in,
// rather than parking speculative numbers in the real data file.

async function withPatchedData(patch) {
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => m.type() === 'error' && ours(m.location()?.url) && errs.push(m.text()));
  await p.route('**/compendium.json', async route => {
    const res = await route.fetch();
    const doc = JSON.parse(await res.text());
    patch(doc);
    await route.fulfill({ response: res, body: JSON.stringify(doc), headers: { 'content-type': 'application/json' } });
  });
  await p.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  return { p, errs };
}

// A precision nobody has used before should grow its own column.
{
  const { p, errs } = await withPatchedData(doc => {
    const t = doc.units.find(x => x.id === 'rtx_pro_6000');
    // A precision the catalog has never seen and the renderer has no ordering
    // rule for -- the real extensibility case, not one that already has a column.
    t.compute.values.fp6 = 1234;
    t.pricing.msrp = { usd: 8565, asOf: '2025-04' };
  });
  const heads = await p.locator('#specTable thead th').allTextContents();
  check('unknown precision key grows a column', heads.includes('FP6'), heads.join(','));
  check('injected rated throughput renders', (await p.locator('#specTable tbody').textContent()).includes('1234'));
  check('injected MSRP renders', (await p.locator('#specTable tbody').textContent()).includes('$8,565'));
  // Sparsity figures pair into their dense column instead of doubling the width.
  check('sparse figure renders beside its dense twin', (await p.locator('#specTable tbody').textContent()).includes('3352 sp'), 'expected the 5090 FP4 sparse rate');
  check('extensibility patch caused no errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// A device added with nothing but a name must render as gaps, not a blank page.
{
  const { p, errs } = await withPatchedData(doc => {
    doc.platforms.push({
      id: 'newthing',
      display: { label: 'Brand New Accelerator', short: 'NewThing', color: '#8888ff', group: 'Value' },
    });
  });
  check('minimal device does not break the page', errs.length === 0, errs.join(' | '));
  check('minimal device appears in the legend', (await p.locator('#pleg').textContent()).includes('NewThing'));
  check('minimal device appears in the prefill table', (await p.locator('#ppTable tbody').textContent()).includes('NewThing'));
  check('minimal device renders em dashes', (await p.locator('#ppTable tbody tr').count()) === 34);
  // A reference unit has no build behind it, so its "Used in" cell is empty
  // rather than the row being dropped.
  check('reference units appear in the catalog', (await p.locator('#specTable tbody').textContent()).includes('MI355X'));
  await p.close();
}

// Correcting one card's street price must move every rig containing it, by
// exactly the unit count. This is the whole point of composing builds.
{
  const costOf = async (p, short) => {
    const row = p.locator('#valTable tbody tr', { hasText: short }).first();
    return (await row.locator('td').nth(1).textContent()).trim();
  };
  const { p: before } = await withPatchedData(() => {});
  const base3090 = await costOf(before, '4× 3090');
  const basePro = await costOf(before, 'PRO 6000');
  await before.close();

  const { p: after, errs } = await withPatchedData(doc => {
    // +$300 on a card the 4x 3090 rig contains four of.
    doc.units.find(u => u.id === 'rtx_3090').pricing.street.usd += 300;
  });
  check('four-card rig tracks its card price ×4', (await costOf(after, '4× 3090')) === '$6,000', `${base3090} → ${await costOf(after, '4× 3090')}`);
  check('unrelated build is unaffected', (await costOf(after, 'PRO 6000')) === basePro);
  check('price change caused no errors', errs.length === 0, errs.join(' | '));
  await after.close();
}

// A single-card price must flow through the platform that composes it and into
// the build that references that platform -- two levels of derivation.
{
  const { p } = await withPatchedData(doc => {
    doc.units.find(u => u.id === 'pg199_card').pricing.street.usd = 2000;
  });
  const row = p.locator('#valTable tbody tr', { hasText: '4× PG199' }).first();
  const cost = (await row.locator('td').nth(1).textContent()).trim();
  check('card price flows through platform into build', cost === '$8,000', `got ${cost}`);
  await p.close();
}

// The whole point of splitting v100 and b70 into single-card origins: the
// four-card rig must track the card, not a stored total.
{
  const { p } = await withPatchedData(doc => {
    doc.units.find(u => u.id === 'v100_sxm2').pricing.street.usd = 1500;
  });
  const row = p.locator('#valTable tbody tr', { hasText: '4× V100' }).first();
  const cost = (await row.locator('td').nth(1).textContent()).trim();
  check('four-card V100 platform tracks its card price', cost === '$6,000', `got ${cost}`);
  await p.close();
}
{
  const { p } = await withPatchedData(doc => {
    doc.units.find(u => u.id === 'arc_b70').power.idleW = 30;
  });
  const row = p.locator('#valTable tbody tr', { hasText: 'B70×4' }).first();
  const idle = (await row.locator('td').nth(3).textContent()).trim();
  check('four-card B70 platform tracks its card idle draw', idle === '120', `got ${idle}`);
  await p.close();
}

// An unknown confidence code should surface a readable message, not a blank page.
{
  const { p } = await withPatchedData(doc => {
    doc.platforms[0].perf.moe.prefill['512'] = [7640, 'bogus'];
  });
  const banner = await p.locator('#loadError').textContent();
  check('bad confidence code surfaces an error banner', /unknown confidence code/.test(banner), banner.slice(0, 120));
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
