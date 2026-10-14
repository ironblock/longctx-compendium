#!/usr/bin/env node
// Holds assets/ceiling.js to arithmetic done by hand, one case per kind of
// attention the page models, and proves tools/check-ceilings.mjs can fail.
// The expected figures below are written out from the model configs, not
// computed by the code under test.
//
//   node tools/test-ceilings.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../assets/models.js';
import * as C from '../assets/ceiling.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const near = (name, got, want, tol = 1e-9) => {
  const ok = got != null && Math.abs(got - want) <= Math.abs(want) * tol;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` -- got ${got}, want ${want}`}`);
};
const unit = (bw, extra = {}) => ({ memoryBandwidthGBs: bw, memoryGB: 80, formats: { fp16: 'native', bf16: 'native' }, compute: { values: { fp16: 100, bf16: 100 } }, ...extra });

// Llama 3.1 8B, FP16, empty context: every weight but the untied input
// embedding (128,256 x 4,096) is read once per token.
{
  const bytes = (8030261248 - 128256 * 4096) * 2;
  near('Llama 3.1 8B: decode bytes skip the untied embedding', C.decodeBytesPerStep(MODELS.llama31_8b, { bpw: 16, depth: 0 }).total, bytes);
  near('Llama 3.1 8B: 1 TB/s decode ceiling', C.decodeCeiling(MODELS.llama31_8b, unit(1000), { bpw: 16, depth: 0 }).tps, 1e12 / bytes);
}

// Qwen3-32B, Q8_0 weights, F16 cache, 32K deep, on a 3090's 936 GB/s:
// 64 full-attention layers x 8 KV heads x 128 x (K and V) x 2 bytes per position.
const q32 = MODELS.qwen3_32b;
const q32Weights = ((32.8e9 - 151936 * 5120) * 8.5) / 8;
const q32KvPerPos = 64 * 8 * 128 * 2 * 2;
{
  near('Qwen3-32B: KV per token', C.kvBytesPerToken(q32), q32KvPerPos);
  near('Qwen3-32B: decode at 32K on 936 GB/s', C.decodeCeiling(q32, unit(936), { bpw: 8.5, depth: 32768 }).tps, 936e9 / (q32Weights + q32KvPerPos * 32768));
  // Two streams: weights once, each stream's own cache.
  near('Qwen3-32B: two-stream aggregate', C.decodeCeiling(q32, unit(936), { bpw: 8.5, depth: 32768, streams: 2, basis: 'aggregate' }).tps, (2 * 936e9) / (q32Weights + 2 * q32KvPerPos * 32768));
  // Tensor parallel over 4 cards draws on all four cards' bandwidth; a layer split on one.
  near('Qwen3-32B: 4-way tensor parallel', C.decodeCeiling(q32, unit(936), { cards: 4, mode: 'tensor', bpw: 8.5, depth: 32768 }).tps, (4 * 936e9) / (q32Weights + q32KvPerPos * 32768));
  near('Qwen3-32B: 4-way layer split', C.decodeCeiling(q32, unit(936), { cards: 4, mode: 'layer', bpw: 8.5, depth: 32768 }).tps, 936e9 / (q32Weights + q32KvPerPos * 32768));
  // Prefill, one token appended at 32K: 2 FLOPs per read weight, plus
  // 4 x 64 heads x 128 per attended position on each of 64 layers.
  const flops = 2 * (32.8e9 - 151936 * 5120) + 4 * 64 * 128 * 64 * 32768;
  near('Qwen3-32B: prefill FLOPs per appended token at 32K', C.prefillFlopsPerToken(q32, 32768), flops);
  near('Qwen3-32B: BF16 prefill ceiling at 100 TFLOPS', C.prefillCeiling(q32, unit(936), { formatKey: 'bf16', depth: 32768 }).tps, 100e12 / flops);
}

// Gemma 4 31B at 128K, F16: 10 full layers of 4 KV heads x 512 with keys equal
// to values (one tensor), 50 sliding layers of 16 x 256 (K and V) held for
// only their 1,024-token window.
{
  const full = 10 * 4 * 512 * 1 * 2 * 131072;
  const slide = 50 * 16 * 256 * 2 * 2 * 1024;
  near('Gemma 4 31B: KV held at 128K', C.kvBytesAt(MODELS.gemma4_31b, 131072), full + slide);
}

// GLM-4.7-Flash: multi-head latent attention caches 512 + 64 values per
// position on each of 47 layers, once, whatever the head count.
{
  near('GLM-4.7-Flash: MLA cache per token', C.kvBytesPerToken(MODELS.glm47_flash), 47 * (512 + 64) * 2);
  // Under 4-way tensor parallel every card holds the whole latent.
  const g = MODELS.glm47_flash;
  const f = C.fit(g, { memoryGB: 32 }, { cards: 4, mode: 'tensor', bpw: 4.83, depth: 262144 });
  near('GLM-4.7-Flash: latent copied to each of 4 cards', f.kv, 4 * 47 * 576 * 2 * 262144);
}

// Qwen3.8-27B: 48 Gated DeltaNet layers each hold 48 value heads of a
// 128 x 128 FP32 state; only the 16 full-attention layers grow with depth.
{
  const m = MODELS.qwen38_27b;
  near('Qwen3.8-27B: recurrent state', C.recurrentStateBytes(m), 48 * 48 * 128 * 128 * 4);
  near('Qwen3.8-27B: KV per token at q8_0', C.kvBytesPerToken(m, 'q8_0'), 16 * 4 * 256 * 2 * (34 / 32));
}

// Qwen3.8-Flash-Next's sparse full-attention layers store every position but
// read at most 2,048 of them a step.
{
  const m = MODELS.qwen38_flash_next;
  near('Flash-Next: cache stored at 128K', C.kvBytesAt(m, 131072), 12 * 2 * 256 * 2 * 2 * 131072);
  near('Flash-Next: cache read at 128K', C.kvReadBytesAt(m, 131072), 12 * 2 * 256 * 2 * 2 * 2048);
}

// A line with no named model but a stated size gets a weights-only bound.
{
  const line = { model: null, modelParams: { total: 27e9 }, rig: { units: [{ unit: 'x', count: 1 }] }, quant: { format: 'Q8_0', key: 'q8_0' } };
  const c = C.ceilingFor(line, { metric: 'decode', depth: null, streams: 1, basis: 'per-stream' }, { x: unit(256) });
  near('a 27B dense model at Q8_0 on 256 GB/s', c.tps, 256e9 / ((27e9 * 8.5) / 8));
}

// check-ceilings must fail on a reading above its ceiling.
{
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));
  const l = doc.lines.find(x => x.id === 'x_5090_qwen3_32b_llamacpp');
  l.results.find(r => r.metric === 'decode' && r.depth === 32768).value = 900;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ceilings-')), 'bad.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  const run = spawnSync('node', [path.join(root, 'tools/check-ceilings.mjs'), file], { encoding: 'utf8' });
  const ok = run.status === 1 && /x_5090_qwen3_32b_llamacpp decode@32768/.test(run.stderr);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} check-ceilings fails on an impossible reading${ok ? '' : ` -- exit ${run.status}: ${run.stderr.slice(0, 200)}`}`);
}

if (failed) {
  console.error(`\n✗ ${failed} ceiling check${failed > 1 ? 's' : ''} failed`);
  process.exit(1);
}
console.log('\n✓ ceilings agree with the hand arithmetic');
