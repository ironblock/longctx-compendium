#!/usr/bin/env node
// Proves tools/validate.mjs rejects the mistakes it claims to catch. A
// validator nobody has seen fail is just a script that prints a checkmark.
//
//   node tools/test-validate.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const good = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compendium-test-'));

const clone = () => JSON.parse(JSON.stringify(good));
const platform = (doc, id) => doc.platforms.find(p => p.id === id);

// Each case breaks the data one way and names the substring the failure must
// mention, so a check that starts passing for the wrong reason still fails.
const CASES = [
  ['unknown confidence code', 'confidence', d => {
    platform(d, 'pro6000').perf.moe.prefill['512'] = [7640, 'measured'];
  }],
  ['confidence code omitted', 'allowed form', d => {
    platform(d, 'pro6000').perf.moe.prefill['512'] = 7640;
  }],
  ['prefill key not on the context axis', 'not a context', d => {
    platform(d, 'pro6000').perf.moe.prefill['20000'] = [500, 'e'];
  }],
  ['duplicate platform id', 'duplicate id', d => {
    d.platforms.push(clone().platforms[0]);
  }],
  ['two devices sharing a colour', 'already used by', d => {
    platform(d, 'rtx5090').display.color = platform(d, 'pro6000').display.color;
  }],
  ['archetype not declared in meta', 'not in meta.archetypes', d => {
    platform(d, 'pro6000').perf.mamba = { note: 'x', decode: { short: [10, 'm'] } };
  }],
  ['misspelled field name', 'unknown property', d => {
    platform(d, 'pro6000').hardware.memoryGb = 96;
  }],
  ['rig costing less than one of its own cards', 'less than the street price', d => {
    platform(d, 'v100').pricing.street = { usd: 9000, asOf: '2026-07' };
  }],
  ['archetype entry with no data and no reason', 'neither data nor unsupported', d => {
    platform(d, 'pro6000').perf.moe = { note: 'todo' };
  }],
  ['unsupported archetype that still has numbers', 'still carries', d => {
    platform(d, 'rtx5090').perf.oss120b.decode = { short: [10, 'm'] };
  }],
  ['negative power draw', 'must be > 0', d => {
    platform(d, 'pro6000').system.loadW = -5;
  }],
  ['malformed colour', 'does not match', d => {
    platform(d, 'pro6000').display.color = 'green';
  }],
  ['release date that is not a date', 'does not match', d => {
    platform(d, 'pro6000').hardware.released = 'spring 2025';
  }],
  ['unknown precision key shape', 'does not match', d => {
    platform(d, 'pro6000').hardware.compute.values['FP 16'] = 250;
  }],
];

let passed = 0;
const failures = [];

// The unmodified file must pass, or every negative result below is meaningless.
try {
  execFileSync('node', [path.join(root, 'tools/validate.mjs')], { stdio: 'pipe' });
  passed++;
} catch (e) {
  failures.push(`baseline: the real data file does not validate\n${e.stderr}`);
}

for (const [name, expect, mutate] of CASES) {
  const doc = clone();
  mutate(doc);
  const file = path.join(tmp, `${name.replace(/\W+/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  let out = '';
  let exitCode = 0;
  try {
    execFileSync('node', [path.join(root, 'tools/validate.mjs'), file], { stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
    out = String(e.stderr);
  }

  if (exitCode === 0) failures.push(`"${name}" was accepted but should have been rejected`);
  else if (!out.includes(expect)) {
    failures.push(`"${name}" was rejected, but not for the right reason (wanted "${expect}"):\n${out.trim()}`);
  } else passed++;
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`✗ validator tests — ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(`✓ validator tests — ${passed} passed (1 baseline + ${CASES.length} rejections)`);
