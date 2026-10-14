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
const unit = (doc, id) => doc.units.find(u => u.id === id);
const arch = (doc, id) => doc.architectures.find(a => a.id === id);
const line = (doc, id) => doc.lines.find(l => l.id === id);
const candidate = (doc, id) => doc.candidates.find(c => c.id === id);
// A first-party line with decode and prefill points.
const L = 'l_3090_27b_iq3s_dflash2';
// A reported line from a review site, single card, no depth on its decode point.
const R = 'x_5090_qwen3_32b_llamacpp';

// Each case breaks the data one way and names the substring the failure must
// mention, so a check that starts passing for the wrong reason still fails.
const CASES = [
  ['an estimated figure in the ledger', 'must be one of', d => {
    line(d, R).results[0].confidence = 'e';
  }],
  ['duplicate id across collections', 'duplicate id', d => {
    d.lines.push(clone().lines[0]);
  }],
  ['a unit id colliding with a line id', 'duplicate id', d => {
    unit(d, 'v100_sxm2').id = L;
  }],
  ['an architecture id colliding with a unit id', 'duplicate id', d => {
    arch(d, 'volta').id = 'v100_sxm2';
  }],
  ['misspelled field name', 'unknown property', d => {
    unit(d, 'rtx_pro_6000').memoryGb = 96;
  }],
  ['a unit naming a generation that does not exist', 'unknown architecture', d => {
    unit(d, 'rtx_pro_6000').arch = 'rubin';
  }],
  ['a rated figure its generation says cannot exist', 'says fp8 is absent', d => {
    unit(d, 'rtx_3090').compute.values.fp8 = 300;
  }],
  ['a format override with no note', 'without a note', d => {
    const u = unit(d, 'rtx_4090');
    u.formatOverrides = { fp4: 'native' };
    delete u.note;
  }],
  ['a format state outside the three allowed', 'must be one of', d => {
    arch(d, 'ampere').formats.fp8 = 'emulated';
  }],
  ['a generation with no sources', 'missing required property "sources"', d => {
    delete arch(d, 'ampere').sources;
  }],
  ['specs with no source', 'no sources[]', d => {
    const u = unit(d, 'pg199_card');
    delete u.sources;
    delete u.compute.source;
    u.tdpW = 350;
  }],
  ['negative power draw', 'must be > 0', d => {
    unit(d, 'rtx_3090').power.loadW = -1;
  }],
  ['fractional card count', 'expected integer', d => {
    line(d, L).rig.units[0].count = 1.5;
  }],
  ['release date that is not a date', 'does not match', d => {
    unit(d, 'rtx_pro_6000').released = 'spring 2025';
  }],
  ['unknown precision key shape', 'does not match', d => {
    unit(d, 'rtx_pro_6000').compute.values['FP 16'] = 250;
  }],
  ['line for a model with no shape entry', 'not in MODELS', d => {
    line(d, L).model = 'qwen99_100b';
  }],
  ['a line with no model and no note saying why', 'no modelNote', d => {
    line(d, R).model = null;
  }],
  ['a weight format the ceiling code does not know', 'not in WEIGHT_FORMATS', d => {
    line(d, R).quant.key = 'q9_z';
  }],
  ['a line with no recorded date', 'missing required property "recorded"', d => {
    delete line(d, R).recorded;
  }],
  ['observed after it was recorded', 'after it was recorded', d => {
    line(d, R).observed = '2027-01';
  }],
  ['a parallel split on one card', 'single card', d => {
    line(d, R).parallel = { mode: 'tensor' };
  }],
  ['a point with no depth and no word on why', 'no depthNote', d => {
    delete line(d, R).results.find(r => r.depth == null).depthNote;
  }],
  ['line whose rig names a unit that does not exist', 'unknown unit', d => {
    line(d, L).rig.units[0].unit = 'nosuchcard';
  }],
  ['a point carrying both a value and a range', 'exactly one of value or range', d => {
    line(d, L).results[0].range = [70, 80];
  }],
  ['a point carrying neither value nor range', 'exactly one of value or range', d => {
    delete line(d, L).results[0].value;
  }],
  ['a reversed range', 'is reversed', d => {
    const r = line(d, 'l_ada48_flash_exl3_2p05_mtp3').results[0];
    r.range = [r.range[1], r.range[0]];
  }],
  ['aggregate claimed for one stream', 'one stream is per-stream', d => {
    line(d, L).results[0].basis = 'aggregate';
  }],
  ['prefill that does not say cold or new-tokens', 'prefillBasis', d => {
    delete line(d, L).results.find(r => r.metric === 'prefill').prefillBasis;
  }],
  ['the same point twice', 'repeats an earlier point', d => {
    line(d, L).results.push(JSON.parse(JSON.stringify(line(d, L).results[0])));
  }],
  ['an issue report with no reproduction status', 'reproduced', d => {
    line(d, L).provenance = { kind: 'issue-report', attestation: 'reported', source: 'https://example.invalid/issues/1' };
  }],
  ['attestation outside the declared set', 'must be one of', d => {
    line(d, L).provenance.attestation = 'vibes';
  }],
  ['a source kind outside the declared set', 'must be one of', d => {
    line(d, R).provenance.kind = 'modeled';
  }],
  ['a field the provenance no longer has', 'unknown property', d => {
    line(d, L).provenance.authorship = 'agent-authored';
  }],
  ['an issue report claimed as witnessed', 'cannot be witnessed', d => {
    line(d, L).provenance = { kind: 'issue-report', attestation: 'witnessed', source: 'https://example.invalid/issues/1', reproduced: false };
  }],
  ['a withdrawn line that never says why', 'never says why', d => {
    const l = line(d, L);
    l.status = 'withdrawn';
    delete l.hazards;
  }],
  ['a measured line with no results', 'no results', d => {
    line(d, L).results = [];
  }],
  ['draft acceptance above one', 'must be <=', d => {
    line(d, L).results[0].acceptance = 1.5;
  }],
  ['a candidate for a model with no shape entry', 'not in MODELS', d => {
    candidate(d, 'c_mi100x4').models = ['qwen99_100b'];
  }],
  ['a candidate id colliding with a line id', 'duplicate id', d => {
    candidate(d, 'c_mi100x4').id = L;
  }],
  ['an interconnect rating with no source', 'no source', d => {
    delete candidate(d, 'c_mi100x4').rig.interconnect.source;
  }],
  ['a bridge price range that runs backwards', 'is reversed', d => {
    candidate(d, 'c_mi100x4').rig.interconnect.costHighUsd = 100;
  }],
  ['a high bridge price with no low one', 'no low one', d => {
    delete candidate(d, 'c_mi100x4').rig.interconnect.costUsd;
  }],
  ['a negative peer bandwidth', 'must be > 0', d => {
    candidate(d, 'c_mi100x4').rig.interconnect.peakP2pGBsPerGpu = -1;
  }],
  ['a candidate rig pointing at a unit that does not exist', 'unknown unit', d => {
    candidate(d, 'c_mi100x4').rig.units[0].unit = 'nosuchcard';
  }],
  ['the old platforms collection coming back', 'unknown property', d => {
    d.platforms = [];
  }],
];

// Edits that must be ACCEPTED. A validator that rejects legitimate data is as
// obstructive as one that lets bad data through, and these are the cases most
// likely to get over-tightened by accident.
const ACCEPTED = [
  ['a reference unit nothing uses', null, d => {
    d.units.push({ ...clone().units.find(u => u.id === 'a100_80'), id: 'reference_card' });
  }],
  ['a unit with no price', null, d => {
    delete unit(d, 'rtx_5090').pricing;
  }],
  ['a device carrying only a name', 'names no chip generation', d => {
    d.units.push({ id: 'blank_card', label: 'Unknown Accelerator' });
  }],
  ['a card overriding its generation, with a note', null, d => {
    const u = unit(d, 'rtx_4090');
    u.formatOverrides = { fp4: 'native' };
    u.note = 'test fixture';
  }],
  ['a line from a source that did not name its model', null, d => {
    line(d, R).model = null;
    line(d, R).modelNote = 'The source says only "a 32B".';
  }],
  ['a multi-card line that does not say how it split', 'without saying how the model was split', d => {
    line(d, R).rig.units[0].count = 2;
  }],
  ['a first-party line with no digest', 'pins no digest', d => {
    delete line(d, L).provenance.digest;
  }],
  ['a point deeper than the pool', 'is more than the', d => {
    line(d, L).results.push({ metric: 'decode', depth: 500000, streams: 1, basis: 'per-stream', value: 10, confidence: 'm' });
  }],
  ['a first-party measurement the maintainer did not personally see', null, d => {
    line(d, L).provenance.attestation = 'reported';
  }],
  ['a bridge that costs nothing because it ships with the cards', null, d => {
    const ic = candidate(d, 'c_max1100x2').rig.interconnect;
    ic.costUsd = 0;
    delete ic.costHighUsd;
  }],
  ['an unreproduced issue report that says so', null, d => {
    line(d, L).provenance = { kind: 'issue-report', attestation: 'reported', source: 'https://example.invalid/issues/1', reproduced: false };
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
