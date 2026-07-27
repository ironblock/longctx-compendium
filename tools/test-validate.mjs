#!/usr/bin/env node
// Proves tools/validate.mjs rejects the mistakes it claims to catch. A
// validator nobody has seen fail is just a script that prints a checkmark.
//
//   node tools/test-validate.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const good = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compendium-test-'));

const clone = () => JSON.parse(JSON.stringify(good));
const platform = (doc, id) => doc.platforms.find(p => p.id === id);
const build = (doc, id) => doc.builds.find(b => b.id === id);
const unit = (doc, id) => doc.units.find(u => u.id === id);

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
  ['duplicate id across collections', 'duplicate id', d => {
    d.platforms.push(clone().platforms[0]);
  }],
  ['a unit id colliding with a platform id', 'duplicate id', d => {
    unit(d, 'v100_sxm2').id = 'v100';
  }],
  ['two devices sharing a colour', 'already used by', d => {
    platform(d, 'rtx5090').display.color = platform(d, 'pro6000').display.color;
  }],
  ['archetype not declared in meta', 'not in meta.archetypes', d => {
    platform(d, 'pro6000').perf.mamba = { note: 'x', decode: { short: [10, 'm'] } };
  }],
  ['misspelled field name', 'unknown property', d => {
    unit(d, 'rtx_pro_6000').memoryGb = 96;
  }],
  ['platform composition pointing at a unit that does not exist', 'unknown unit', d => {
    platform(d, 'v100').composition[0].unit = 'nosuchcard';
  }],
  ['build pointing at a platform that does not exist', 'unknown platform', d => {
    build(d, 'b_pro').units[0].platform = 'nosuchplatform';
  }],
  ['costed unit with no street price', 'cost cannot be derived', d => {
    delete unit(d, 'v100_sxm2').pricing.street;
  }],
  ['costed unit with no power figures', 'efficiency cannot be derived', d => {
    delete unit(d, 'v100_sxm2').power;
  }],
  ['build entry naming both a platform and a unit', 'pick one', d => {
    build(d, 'b_pro').units[0].unit = 'rtx_pro_6000';
  }],
  // rtx_3090 is deliberately still unsourced; picking an already-sourced unit
  // here would make this case pass without exercising the rule.
  ['specs with no source', 'no sources[]', d => {
    unit(d, 'rtx_3090').tdpW = 350;
  }],
  ['build cost stored instead of derived', 'unknown property', d => {
    build(d, 'b_pro').buildCostUsd = 8500;
  }],
  ['platform storing its own price instead of composing', 'unknown property', d => {
    platform(d, 'pro6000').pricing = { street: { usd: 8500 } };
  }],
  ['archetype entry with no data and no reason', 'neither data nor unsupported', d => {
    platform(d, 'pro6000').perf.moe = { note: 'todo' };
  }],
  ['unsupported archetype that still has numbers', 'still carries', d => {
    platform(d, 'rtx5090').perf.oss120b.decode = { short: [10, 'm'] };
  }],
  ['negative power draw', 'must be > 0', d => {
    unit(d, 'rtx_pro_6000').power.loadW = -5;
  }],
  ['fractional card count', 'expected integer', d => {
    build(d, 'b_3090').units[0].count = 3.5;
  }],
  ['malformed colour', 'does not match', d => {
    platform(d, 'pro6000').display.color = 'green';
  }],
  ['release date that is not a date', 'does not match', d => {
    unit(d, 'rtx_pro_6000').released = 'spring 2025';
  }],
  ['unknown precision key shape', 'does not match', d => {
    unit(d, 'rtx_pro_6000').compute.values['FP 16'] = 250;
  }],
];

// Edits that must be ACCEPTED. A validator that rejects legitimate data is as
// obstructive as one that lets bad data through, and these are the cases most
// likely to get over-tightened by accident.
const ACCEPTED = [
  ['a reference unit nothing uses', 'no platform or build uses it', d => {
    d.units.push({ ...clone().units.find(u => u.id === 'a100_80'), id: 'reference_card' });
  }],
  ['a benchmark-only platform with no price', null, d => {
    // rtx5090 and r9700 never clear 96GB, so they never reach a build.
    delete unit(d, 'rtx_5090').pricing;
  }],
  ['a device carrying only a name', null, d => {
    d.units.push({ id: 'blank_card', label: 'Unknown Accelerator' });
    d.platforms.push({
      id: 'blank_platform',
      display: { label: 'Unknown', short: 'Unknown', color: '#123456', group: 'Value' },
      composition: [{ unit: 'blank_card', count: 1 }],
    });
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

for (const [name, expectWarning, mutate] of ACCEPTED) {
  const doc = clone();
  mutate(doc);
  const file = path.join(tmp, `ok-${name.replace(/\W+/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  // spawnSync rather than execFileSync: warnings go to stderr on an otherwise
  // successful run, and we need both streams from one invocation.
  const run = spawnSync('node', [path.join(root, 'tools/validate.mjs'), file], { encoding: 'utf8' });

  if (run.status !== 0) {
    failures.push(`"${name}" should have been accepted but was rejected:\n${run.stderr}`);
  } else if (expectWarning && !run.stderr.includes(expectWarning)) {
    failures.push(`"${name}" was accepted but did not warn about "${expectWarning}"`);
  } else passed++;
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`✗ validator tests — ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(
  `✓ validator tests — ${passed} passed ` +
    `(1 baseline + ${CASES.length} rejections + ${ACCEPTED.length} acceptances)`
);
