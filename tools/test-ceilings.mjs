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
const same = (name, got, want) => {
  const ok = got === want;
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

  // A card with no matrix units is bounded by its fastest shader rate, here
  // 53 TOPS of dot-product INT8 against 26.5 TFLOPS of packed FP16.
  const absent = Object.fromEntries(['tf32', 'bf16', 'fp16', 'fp8', 'fp6', 'fp4', 'int8', 'int4'].map(f => [f, 'absent']));
  const noMatrix = unit(1024, { formats: absent, compute: { values: { 'fp16:vector': 26.5, 'int8:vector': 53 } } });
  const vec = C.prefillCeiling(q32, noMatrix, { formatKey: 'q4_k_m', depth: 32768 });
  near('No matrix units: Q4_K_M prefill bounded by the fastest vector rate', vec.tps, 53e12 / flops);
  const vecOk = vec.precision.vector === true && vec.precision.precision === 'int8' && !vec.precision.unofficial;
  if (!vecOk) failed++;
  console.log(`${vecOk ? '✓' : '✗'} No matrix units: the bound says it is a vector INT8 rate`);
  // The same bound from a figure the vendor never published says so.
  const derived = C.prefillCeiling(q32, { ...noMatrix, compute: { ...noMatrix.compute, unofficial: ['int8:vector'] } }, { formatKey: 'q4_k_m', depth: 32768 });
  const offOk = derived.precision.unofficial === true && derived.tps === vec.tps;
  if (!offOk) failed++;
  console.log(`${offOk ? '✓' : '✗'} An unofficial vector rate still bounds, and says it is unofficial`);
  // An unofficial figure the ceiling does not use leaves the label alone.
  const other = C.prefillCeiling(q32, unit(936, { compute: { values: { fp16: 100, bf16: 100 }, unofficial: ['fp16'] } }), { formatKey: 'bf16', depth: 32768 });
  const otherOk = other.precision.unofficial !== true && other.tps != null;
  if (!otherOk) failed++;
  console.log(`${otherOk ? '✓' : '✗'} An unofficial figure the ceiling does not rest on is not reported`);
  // A card with a matrix path but no rating for it must not fall back: its
  // matrix units may beat the vector rate, so no bound is the honest answer.
  const unrated = unit(1024, { formats: { ...absent, fp16: 'native' }, compute: { values: { 'fp16:vector': 26.5 } } });
  const none = C.prefillCeiling(q32, unrated, { formatKey: 'bf16', depth: 32768 }).tps;
  if (none != null) failed++;
  console.log(`${none == null ? '✓' : '✗'} Unrated matrix path: no vector fallback${none == null ? '' : ` -- got ${none}`}`);
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

// Draft weights and lookup tables. An MTP head adds its weights at the main
// bits per weight; a drafter adds its weights and its own (windowed) cache; a
// lookup table stays out of GPU memory unless placed there.
{
  const m = MODELS.qwen38_27b;
  const args = { cards: 1, mode: 'single', bpw: 4.83, depth: 131072 };
  const base = C.fit(m, { memoryGB: 32 }, args);
  const mtp = C.draftFor('qwen38_27b', 'mtp');
  const withMtp = C.fit(m, { memoryGB: 32 }, { ...args, draft: mtp });
  near('Qwen3.8-27B: MTP head adds its weights', withMtp.need - base.need, (424699392 * 4.83) / 8);
  const d = C.draftFor('qwen38_27b', 'drafter');
  const withDrafter = C.fit(m, { memoryGB: 32 }, { ...args, draft: d });
  // Five sliding layers, 8 KV heads of 128, keys and values, F16, a 2,048-position window.
  near('Qwen3.8-27B: DFlash2 drafter adds weights and a windowed cache', withDrafter.need - base.need, (1924404480 * 4.83) / 8 + 5 * 8 * 128 * 2 * 2 * 2048);
  same('no draft when speculation is off', C.draftFor('qwen38_27b', 'off'), null);
  same('a model with no MTP head says so', C.draftFor('qwen3_coder_next_80b_a3b', 'mtp').missing, 'no MTP head in the checkpoint');
  same('a model with no drafter says so', C.draftFor('qwen38_flash_next', 'drafter').missing, 'no drafter recorded');
  const f = MODELS.qwen38_flash_next;
  const ff = C.fit(f, { memoryGB: 96 }, { ...args, depth: 4096 });
  near('Flash-Next: n-gram table goes to host RAM, in BF16', ff.host, (51200245792 * 16) / 8);
  near('Flash-Next: and stays out of GPU memory', ff.weights, (125e9 * 4.83) / 8);
}

// Lookup-table placement. Host RAM costs decode and prefill nothing; GPU
// memory adds the table to the fit; an SSD adds the read time that outlasts the
// layers before the table, and caps prefill at IOPS / rows per token. The drive
// here is made up so the arithmetic is by hand: 50 us at QD1, 1M IOPS peak.
{
  const f = MODELS.qwen38_flash_next;
  const unit = { memoryBandwidthGBs: 1000, memoryGB: 96, compute: { values: { fp16: 400 } }, formats: { fp16: 'native' } };
  const drive = { randomRead: { qd1Iops: 20000, peakIops: 1e6 } };
  const args = { cards: 1, mode: 'single', bpw: 4.83, depth: 4096 };
  const free = C.decodeCeiling(f, unit, args);
  const T = 1 / free.tps;
  near('a drive at 20,000 QD1 IOPS takes 50 us a read', C.driveLatency(drive), 50e-6);
  near('16 rows together: one latency, then 16 at the peak rate', C.driveReadSeconds(16, drive, 'together'), 50e-6 + 16 / 1e6);
  near('16 rows one at a time: a latency each', C.driveReadSeconds(16, drive, 'serial'), 16 * 50e-6);
  same('Flash-Next reads 16 rows a token', C.lookupRowsPerToken(f), 16);

  const ram = C.tablePlan(f, { place: 'ram' });
  same('host RAM: decode is not penalized', C.decodeCeiling(f, unit, { ...args, table: ram }).tps, free.tps);
  same('host RAM: prefill is not penalized', C.prefillCeiling(f, unit, { formatKey: 'fp16', depth: 4096, table: ram }).tps, C.prefillCeiling(f, unit, { formatKey: 'fp16', depth: 4096 }).tps);
  same('host RAM: GPU memory is not charged', C.fit(f, unit, { ...args, table: ram }).need, C.fit(f, unit, args).need);
  same('a 128 GB host holds the BF16 table (95.4 GiB + 8 GiB)', C.tablePlan(f, { place: 'ram', hostGB: 128 }).host.holds, true);
  same('a 64 GB host does not', C.tablePlan(f, { place: 'ram', hostGB: 64 }).host.holds, false);
  same('no host chosen: no verdict', C.tablePlan(f, { place: 'ram' }).host.holds, null);

  const gpu = C.tablePlan(f, { place: 'gpu', bits: 8 });
  near('GPU memory at 8 bits: the fit grows by 51.2 GB', C.fit(f, unit, { ...args, table: gpu }).need - C.fit(f, unit, args).need, 51200245792);
  near('4.5-bit copy: 28.8 GB', C.lookupBytes(f, 4.5), (51200245792 * 4.5) / 8);
  near('bits above what ships are ignored', C.lookupBytes(f, 32), (51200245792 * 16) / 8);

  const ssd = C.tablePlan(f, { place: 'ssd', drive });
  const d = C.decodeCeiling(f, unit, { ...args, table: ssd });
  const window = T / 48;
  near('SSD: the window is the one layer before layer 2', d.ssd.window, window);
  near('SSD: decode pays what outlasts the window, rows together', d.tps, 1 / (T + Math.max(0, 66e-6 - window)));
  near('SSD: and one at a time', d.ssd.serialTps, 1 / (T + Math.max(0, 800e-6 - window)));
  const p = C.prefillCeiling(f, unit, { formatKey: 'fp16', depth: 4096, table: ssd });
  near('SSD: prefill cap is IOPS / 16', p.ssd.cap, 1e6 / 16);
  near('SSD: one at a time, 1 / (16 x 50 us)', p.ssd.serialCap, 1 / (16 * 50e-6));
  near('SSD: prefill is the lower of compute and the cap', p.tps, Math.min(p.ssd.computeTps, 1e6 / 16));
  const bare = { ...f, lookupReads: undefined };
  same('no read pattern recorded: the cost is not guessed', C.decodeCeiling(bare, unit, { ...args, table: C.tablePlan(bare, { place: 'ssd', drive }) }).ssd.unknown, 'rows per token not recorded');
  same('and the ceiling is left as it is', C.decodeCeiling(bare, unit, { ...args, table: C.tablePlan(bare, { place: 'ssd', drive }) }).tps, free.tps);
}

// Routed experts in host RAM. A made-up MoE model with round numbers: 100B
// weights at 8 bits, 10B read a token, 90B of routed experts over 10 layers
// (9 GB a layer), 5 of 100 experts a token; no cache. One 40 GB card at
// 1,000 GB/s holds 39 GiB = 41,875,931,136 bytes; the host reads at 100 GB/s.
{
  const m = { label: 'test MoE', params: { total: 100e9, active: 10e9 }, layers: 10, layerTypes: { full_attention: 0 }, heads: 1, kvHeads: 1, headDim: 1, moe: { experts: 100, expertsPerToken: 5, layers: 10, routed: 90e9 } };
  const card = { memoryBandwidthGBs: 1000, memoryGB: 40, formats: {}, compute: { values: {} } };
  const host = { bandwidthGBs: 100 };
  const args = { bpw: 8, depth: 0 };
  const gpuOnly = C.decodeCeiling(m, { ...card, memoryGB: 200 }, args).tps;
  near('GPU only: 10 GB a token at 1,000 GB/s', gpuOnly, 100);

  const all = { place: 'cpu', host, hostGB: 128 };
  const fa = C.fit(m, card, { ...args, experts: all });
  near('all on the CPU: the GPU holds the other 10 GB', fa.need, 10e9);
  same('and every layer is the CPU\'s', fa.experts.cpuLayers, 10);
  near('the CPU reads 5/100 of 90 GB = 4.5 GB a token', C.routedReadParams(m), 4.5e9);
  near('decode: 5.5 GB at 1,000 GB/s + 4.5 GB at 100 GB/s = 50.5 ms', C.decodeCeiling(m, card, { ...args, experts: all }).tps, 1 / (5.5e-3 + 45e-3));

  const over = { place: 'overflow', host, hostGB: 64 };
  const fo = C.fit(m, card, { ...args, experts: over });
  same('overflow: 31.9 GB spare holds 3 layers of 9 GB', fo.experts.gpuLayers, 3);
  near('so the GPU holds 10 + 27 GB', fo.need, 37e9);
  near('and the host 63 GB of experts', fo.hostRam.experts, 63e9);
  same('which a 64 GB host does not hold (56 GiB after 8 GiB)', fo.hostRam.holds, false);
  same('and a 128 GB host does', C.fit(m, card, { ...args, experts: { ...over, hostGB: 128 } }).hostRam.holds, true);
  // The GPU's three layers of routed experts (1.35 GB a token) can run while the
  // CPU reads its 3.15 GB, so the ceiling is 5.5 ms + max(1.35, 31.5) ms.
  const od = C.decodeCeiling(m, card, { ...args, experts: over });
  near('decode: 5.5 ms on the GPU, then the larger of 1.35 and 31.5 ms', od.tps, 1 / (5.5e-3 + 31.5e-3));
  near('taking turns: 6.85 GB on the GPU + 3.15 GB on the CPU = 38.35 ms', od.cpu.serialTps, 1 / (6.85e-3 + 31.5e-3));
  same('overflow with room for everything is the GPU-only ceiling', C.decodeCeiling(m, { ...card, memoryGB: 200 }, { ...args, experts: over }).tps, gpuOnly);
  same('experts in GPU memory change nothing', C.decodeCeiling(m, { ...card, memoryGB: 200 }, { ...args, experts: { place: 'gpu', host } }).tps, gpuOnly);
  // A shared expert (1 GB here) overlaps the CPU's routed experts too.
  const sh = { ...m, moe: { ...m.moe, sharedParams: 1e9 } };
  near('all on the CPU with a shared expert: 4.5 ms + max(1, 45) ms', C.decodeCeiling(sh, card, { ...args, experts: all }).tps, 1 / (4.5e-3 + 45e-3));
  const blind = C.decodeCeiling(m, card, { ...args, experts: { place: 'cpu' } });
  same('no host bandwidth: no ceiling, rather than a guess', blind.tps, null);
  same('and it says why', blind.cpu.unknown, 'no host memory bandwidth recorded');
  same('two cards hold two more layers', C.fit(m, card, { ...args, cards: 2, mode: 'tensor', experts: over }).experts.gpuLayers, Math.floor((2 * 39 * 2 ** 30 - 10e9) / 9e9));

  // Prefill: a batch copies the CPU-held experts to the GPU over the host link
  // (25 GB/s each way here). FP8 at 1,000 TFLOPS over 2 x 10B FLOPs a token
  // computes 50,000 tokens/sec; copying 90 GB per 4,096 tokens allows 1,137.8.
  {
    const fast = { ...card, hostGBs: 25, formats: { fp8: 'native' }, compute: { values: { fp8: 1000 } } };
    const f8 = C.fit(m, fast, { ...args, experts: all });
    const p = C.prefillCeiling(m, fast, { formatKey: 'fp8', depth: 0, experts: f8.experts });
    near('prefill: compute alone allows 50,000', p.cpu.computeTps, 50000);
    near('prefill: 4,096 x 25 GB/s / 90 GB', p.tps, (4096 * 25e9) / 90e9);
    near('and 512-token batches, 142', p.cpu.smallCap, (512 * 25e9) / 90e9);
    near('two cards copy over two links', C.prefillCeiling(m, fast, { cards: 2, formatKey: 'fp8', depth: 0, experts: f8.experts }).cpu.cap, (4096 * 50e9) / 90e9);
    same('no expert on the CPU: no cap', C.prefillCeiling(m, fast, { formatKey: 'fp8', depth: 0, experts: { ...f8.experts, cpuLayers: 0, hostBytes: 0 } }).cpu, undefined);
    same('no host link recorded: says so', C.prefillCeiling(m, { ...fast, hostGBs: null }, { formatKey: 'fp8', depth: 0, experts: f8.experts }).cpu.unknown, 'no host link recorded for this card');
  }

  // Lookup tables in host RAM share the host with the experts.
  const lk = { ...m, params: { ...m.params, lookup: 10e9, lookupBits: 16 } };
  const shared = C.fit(lk, card, { ...args, experts: { ...over, hostGB: 64 }, table: C.tablePlan(lk, { place: 'ram' }) });
  near('the host holds 63 GB of experts + 20 GB of table', shared.hostRam.need, 83e9);
}

// Qwen3-30B-A3B from its headers: 48 layers x 128 experts x 3 x 2,048 x 768.
{
  const m = MODELS.qwen3_30b_a3b;
  near('Qwen3-30B-A3B: routed experts', m.moe.routed, 48 * 128 * 3 * 2048 * 768);
  near('Qwen3-30B-A3B: 8 of 128 read a token', C.routedReadParams(m), 48 * 8 * 3 * 2048 * 768);
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

// ...but not on one whose line offloaded that metric beyond what the ceiling
// counts, and only for the metric named.
{
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));
  const l = doc.lines.find(x => x.id === 'x_5090_qwen3_32b_llamacpp');
  const pre = l.results.find(r => r.metric === 'prefill');
  pre.value *= 10;
  l.offload = { to: 'CPU', metrics: ['prefill'], note: 'test' };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ceilings-')), 'offload.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  const pass = spawnSync('node', [path.join(root, 'tools/check-ceilings.mjs'), file], { encoding: 'utf8' }).status === 0;
  l.offload.metrics = ['decode'];
  fs.writeFileSync(file, JSON.stringify(doc));
  const fail = spawnSync('node', [path.join(root, 'tools/check-ceilings.mjs'), file], { encoding: 'utf8' }).status === 1;
  const ok = pass && fail;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} an offloaded metric is exempt, and only that metric${ok ? '' : ` -- prefill offload passed: ${pass}, decode offload failed it: ${fail}`}`);
}

if (failed) {
  console.error(`\n✗ ${failed} ceiling check${failed > 1 ? 's' : ''} failed`);
  process.exit(1);
}
console.log('\n✓ ceilings agree with the hand arithmetic');
