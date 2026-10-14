#!/usr/bin/env node
// Holds every reading in the ledger against the ceiling for its own
// configuration (assets/ceiling.js). A ceiling assumes perfect hardware use, so
// a reading above it means something in its attribution is wrong -- the card
// count, the model, the quant, the depth or the number itself -- not that the
// hardware is unusually fast.
//
//   node tools/check-ceilings.mjs [data.json]          fail on anything over its ceiling
//   node tools/check-ceilings.mjs [data.json] --table  also print every reading's share
//
// Exempt: decode under speculative decoding, which can emit several tokens per
// pass and so can legitimately exceed a one-token-per-pass bound.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../assets/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv.slice(2).find(a => !a.startsWith('--')) ?? path.join(root, 'data/compendium.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const model = normalize(doc);

// 5% slack for the typical-average bits per weight of GGUF recipes.
const SLACK = 1.05;
const table = process.argv.includes('--table');

const over = [];
const why = new Map();
let compared = 0;
let total = 0;
const withdrawn = [];
for (const l of model.LINES) {
  // A withdrawn line is already known to be wrong and says why; it stays on the
  // page, flagged, and is not held to anything here.
  if (l.status === 'withdrawn') {
    withdrawn.push(l.id);
    continue;
  }
  for (const p of l.points) {
    total++;
    if (p.ratio == null) {
      why.set(p.ceiling.why, (why.get(p.ceiling.why) ?? 0) + 1);
      continue;
    }
    compared++;
    const label = `${l.id} ${p.metric}@${p.depth ?? '?'}${p.streams > 1 ? `×${p.streams}` : ''}${p.spec === 'off' ? ' spec-off' : ''}`;
    if (table) console.log(`${(p.ratio * 100).toFixed(1).padStart(6)}%  ${p.ceiling.speculative ? 'spec ' : '     '}${label}`);
    if (p.ratio > SLACK && !p.ceiling.speculative) over.push(`${label}: ${p.value ?? p.range} is ${(p.ratio * 100).toFixed(0)}% of a ${p.ceiling.tps.toFixed(1)} t/s ceiling`);
  }
}

console.log(`\n${compared} of ${total} readings compared with their ceiling${withdrawn.length ? ` (${withdrawn.length} withdrawn line${withdrawn.length > 1 ? 's' : ''} skipped: ${withdrawn.join(', ')})` : ''}. Not compared:`);
for (const [w, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${w}`);

if (over.length) {
  console.error(`\n✗ ${over.length} reading${over.length > 1 ? 's' : ''} above the ceiling for their own configuration:`);
  for (const o of over) console.error(`  ${o}`);
  process.exit(1);
}
console.log('\n✓ no reading claims more than its hardware can do');
