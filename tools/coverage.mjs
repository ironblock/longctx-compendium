#!/usr/bin/env node
// Prints what the catalog is still missing, so filling it in is a checklist
// rather than a hunt. Blanks are legitimate -- this reports them, it does not
// complain about them.
//
//   node tools/coverage.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));

const FIELDS = [
  ['released', u => u.released],
  ['memoryGB', u => u.memoryGB],
  ['bandwidth', u => u.memoryBandwidthGBs],
  ['tdpW', u => u.tdpW],
  ['process', u => u.process],
  ['msrp', u => u.pricing?.msrp?.usd],
  ['street', u => u.pricing?.street?.usd],
  ['power', u => u.power?.loadW],
  ['compute', u => (Object.keys(u.compute?.values ?? {}).length ? Object.keys(u.compute.values).length : undefined)],
  ['sources', u => (u.sources?.length ? u.sources.length : undefined)],
];

const units = doc.units ?? [];
const width = Math.max(...units.map(u => u.id.length));
const head = FIELDS.map(([n]) => n.padStart(9)).join('');
console.log(`\n${'unit'.padEnd(width)}${head}`);
console.log('-'.repeat(width + head.length));

const missing = Object.fromEntries(FIELDS.map(([n]) => [n, 0]));
for (const u of units) {
  const cells = FIELDS.map(([n, get]) => {
    const v = get(u);
    if (v == null) {
      missing[n]++;
      return '·'.padStart(9);
    }
    return String(typeof v === 'number' ? v : v).slice(0, 8).padStart(9);
  });
  console.log(u.id.padEnd(width) + cells.join(''));
}

console.log('-'.repeat(width + head.length));
console.log(
  'missing'.padEnd(width) + FIELDS.map(([n]) => String(missing[n]).padStart(9)).join('')
);

const total = units.length * FIELDS.length;
const filled = total - Object.values(missing).reduce((a, b) => a + b, 0);
console.log(`\n${filled}/${total} fields filled (${Math.round((filled / total) * 100)}%)`);

const unsourced = units.filter(
  u => (u.released != null || u.memoryBandwidthGBs != null || Object.keys(u.compute?.values ?? {}).length) && !u.sources?.length
);
if (unsourced.length) {
  console.log(`\n${unsourced.length} unit(s) carry specs with no sources[]: ${unsourced.map(u => u.id).join(', ')}`);
}

// A precision column only appears in the rendered table once some unit has it.
const precisions = [...new Set(units.flatMap(u => Object.keys(u.compute?.values ?? {})))];
console.log(
  precisions.length
    ? `\nprecisions in the catalog: ${precisions.join(', ')}`
    : '\nno compute.values anywhere yet — the rated-throughput columns are empty'
);
