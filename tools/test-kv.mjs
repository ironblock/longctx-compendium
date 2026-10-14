#!/usr/bin/env node
// Holds the config-derived memory arithmetic (assets/ceiling.js kvBytesPerToken)
// against what the first-party lines actually measured, so a wrong layer count
// or cache width fails here instead of quietly mis-sizing every "does it fit".
//
//   node tools/test-kv.mjs
//
// The formula is a LOWER bound on any engine's real cost -- engines also hold a
// drafter's cache, workspaces and padding -- so the test asserts two things:
// nothing measured is ever below it, and where an engine allocates exactly the
// target's KV (llama.cpp with no separate drafter cache) it lands on it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../assets/models.js';
import { kvBytesPerToken, kvBytesAt, recurrentStateBytes } from '../assets/ceiling.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

for (const [id, a] of Object.entries(MODELS)) {
  const { full_attention: full = 0, sliding_attention: sliding = 0, linear_attention: linear = 0, ffn_only: ffn = 0 } = a.layerTypes;
  check(`${id}: layer types account for every layer`, full + sliding + linear + ffn === a.layers, `${full} + ${sliding} + ${linear} + ${ffn} vs ${a.layers}`);
  check(`${id}: has a full-attention layer to hold a KV cache`, full > 0);
  if (sliding) check(`${id}: sliding layers say how wide their window is`, a.slidingWindow > 0);
  if (linear) check(`${id}: linear layers carry their head shape`, !!a.linear?.valueHeads && !!a.linear?.keyHeadDim && !!a.linear?.valueHeadDim);
  check(`${id}: heads and head size are recorded`, a.heads > 0 && a.kvHeads > 0 && a.headDim > 0);
  if (a.params) check(`${id}: active parameters do not exceed the total`, a.params.active <= a.params.total, `${a.params.active} vs ${a.params.total}`);
  // A sliding layer stops growing at its window; the cache must stop with it.
  if (sliding) {
    const w = a.slidingWindow;
    const growth = kvBytesAt(a, 4 * w) - kvBytesAt(a, 2 * w);
    check(`${id}: past the window, only full-attention layers grow the cache`, growth === kvBytesPerToken(a) * 2 * w);
  }
}

// The registry's own measurement: the 3.8 27B on llama.cpp with q8_0 K and V holds
// 7,616 MiB of KV at a 229,376-token pool (#143; quoted again in #335). The
// config says 16 full-attention layers x 4 KV heads x 256 dims x 2 tensors at
// 34/32 bytes per element -- the same number, to the byte.
const REGISTRY_KV_MIB = 7616;
const REGISTRY_POOL = 229376;
const derived = (kvBytesPerToken(MODELS.qwen38_27b, 'q8_0') * REGISTRY_POOL) / 2 ** 20;
check('qwen38_27b q8_0 KV matches the registry measurement exactly', derived === REGISTRY_KV_MIB, `${derived} MiB vs ${REGISTRY_KV_MIB} MiB`);

console.log('\nper line, measured KiB/token against the config-derived floor:');
for (const l of doc.lines ?? []) {
  const kv = l.kvCache;
  if (!kv?.kibPerToken) continue;
  const floor = kvBytesPerToken(MODELS[l.model], kv.k, kv.v);
  if (floor == null) {
    check(`${l.id}: cache type is one the arithmetic knows`, false, `${kv.k}/${kv.v}`);
    continue;
  }
  const floorKiB = floor / 1024;
  check(`${l.id}: measured is not below the floor`, kv.kibPerToken >= floorKiB * 0.995, `${kv.kibPerToken} vs floor ${floorKiB.toFixed(2)} KiB/token`);
  if (/^llama\.cpp/.test(l.engine.name) && l.spec.method === 'mtp') {
    check(`${l.id}: llama.cpp with an inline MTP head lands on the floor`, Math.abs(kv.kibPerToken - floorKiB) / floorKiB < 0.005);
  }
}

console.log('\nrecurrent state per sequence (an estimate, f32, conv state excluded):');
for (const [id, a] of Object.entries(MODELS)) {
  if (a.layerTypes.linear_attention) console.log(`  ${id}: ${(recurrentStateBytes(a) / 2 ** 20).toFixed(0)} MiB`);
}

if (failed) {
  console.error(`\n✗ ${failed} check${failed > 1 ? 's' : ''} failed`);
  process.exit(1);
}
console.log('\n✓ memory arithmetic agrees with the first-party measurements');
