import { dequantPrecisionFor } from './dequant-map.js';

// Theoretical-maximum roofline model: what a device COULD do, given its own
// rated compute throughput and memory bandwidth, before any measurement.
//
// This exists to catch two different failure modes in the rest of this page:
// a measured number that is physically impossible for the hardware it's
// attributed to (the Strix Halo dense-decode finding that motivated this
// file — a "measured" 10 t/s that needed 112% of the card's own memory bus
// at the quant its own note claimed), and a measured number that is
// plausible but far enough under the ceiling to be worth a second look.
//
// The model is deliberately conservative in one specific sense: it assumes
// perfect utilization (100% of rated FLOPS, 100% of rated bandwidth, zero
// kernel-launch or attention overhead). Nothing real hits this ceiling — a
// measurement at 60-80% of it is unremarkable. A measurement AT or ABOVE it
// is the thing worth flagging.
//
// What it does NOT model, on purpose: attention's own O(n^2) cost (small vs
// the FFN/projection GEMMs until very long context — see marginalSegments()
// in derive.js for how this page treats that separately), MoE routing
// overhead, KV-cache read bandwidth during decode (folded into "attention
// cost", same omission), or any batching/parallelism inefficiency. All of
// these push real hardware BELOW this ceiling, never above it — so omitting
// them keeps the model a genuine upper bound rather than a point estimate.

/**
 * Bits per weight for GGUF block-quantized types, computed from the actual
 * struct layouts in ggml-common.h (llama.cpp), not estimated:
 *
 *   block_q4_K:  2*sizeof(ggml_half) + K_SCALE_SIZE + QK_K/2         =  4+12+128  = 144 B / 256 = 4.5000 bpw
 *   block_q5_K:  2*sizeof(ggml_half) + K_SCALE_SIZE + QK_K/2 + QK_K/8 = 4+12+128+32 = 176 B / 256 = 5.5000 bpw
 *   block_q6_K:  sizeof(ggml_half) + QK_K/16 + 3*QK_K/4              =  2+16+192  = 210 B / 256 = 6.5625 bpw
 *   block_q8_0:  sizeof(ggml_half) + QK8_0                           =  2+32     =  34 B /  32 = 8.5000 bpw
 *   block_mxfp4: sizeof(uint8_t) + QK_MXFP4/2                        =  1+16     =  17 B /  32 = 4.2500 bpw
 *   block_nvfp4: QK_NVFP4/QK_NVFP4_SUB + QK_NVFP4/2                  =  4+32     =  36 B /  64 = 4.5000 bpw
 *
 * fp16/bf16 are 2 bytes/weight unquantized (16 bpw); fp32 is 4 (32 bpw).
 *
 * The "_M"/"_S"/"_L"/"_XL" suffixed llama.cpp quant RECIPES (Q4_K_M etc.)
 * are not a single block type — they mix Q4_K/Q5_K/Q6_K per tensor role
 * (attention vs FFN, and which layers), so their true bpw is model-shape-
 * dependent. The values below are the community-documented typical averages
 * for a Llama-family-shaped model, confidence 'e' (extrapolated), NOT 'm'
 * like the pure block types above. Use BPW_TABLE[baseType] instead whenever
 * a model's real quant recipe isn't known precisely.
 */
export const BPW_TABLE = {
  fp32: { bpw: 32, confidence: 'm', note: 'IEEE754 single, 4 bytes/weight' },
  fp16: { bpw: 16, confidence: 'm', note: 'IEEE754 half, 2 bytes/weight' },
  bf16: { bpw: 16, confidence: 'm', note: 'bfloat16, 2 bytes/weight' },
  q8_0: { bpw: 8.5, confidence: 'm', note: 'ggml-common.h block_q8_0: (2+32)B/32' },
  q6_k: { bpw: 6.5625, confidence: 'm', note: 'ggml-common.h block_q6_K: (2+16+192)B/256' },
  q5_k: { bpw: 5.5, confidence: 'm', note: 'ggml-common.h block_q5_K: (4+12+128+32)B/256' },
  q4_k: { bpw: 4.5, confidence: 'm', note: 'ggml-common.h block_q4_K: (4+12+128)B/256' },
  nvfp4: { bpw: 4.5, confidence: 'm', note: 'ggml-common.h block_nvfp4: (4+32)B/64' },
  mxfp4: { bpw: 4.25, confidence: 'm', note: 'ggml-common.h block_mxfp4: (1+16)B/32' },
  fp8: { bpw: 8, confidence: 'm', note: 'e4m3/e5m2, 1 byte/weight, no ggml block overhead' },
  // Named RECIPES: per-tensor mixed quant, bpw is model-shape-dependent.
  // Typical averages for a Llama/Qwen-family dense model, NOT block-exact.
  q4_k_m: { bpw: 4.83, confidence: 'e', note: 'community-documented typical average; mixes Q4_K/Q6_K by tensor role, varies by model shape', baseType: 'q4_k' },
  q4_k_s: { bpw: 4.58, confidence: 'e', note: 'community-documented typical average', baseType: 'q4_k' },
  q5_k_m: { bpw: 5.69, confidence: 'e', note: 'community-documented typical average', baseType: 'q5_k' },
  q3_k_m: { bpw: 3.91, confidence: 'e', note: 'community-documented typical average', baseType: 'q3_k' },
};

/**
 * Roofline theoretical maximum: time is bounded below by BOTH the compute
 * requirement and the memory-bandwidth requirement, and nothing can go
 * faster than the larger of the two floors -- so realized time is at best
 * max(computeTime, bandwidthTime), never less.
 *
 *   opsPerSec:    rated throughput at the CHOSEN COMPUTE precision, in
 *                 10^12 ops/sec -- the same unit and scale as this page's
 *                 units[].compute.values. This is deliberately a different
 *                 axis from bytesPerParam below: a block-quantized weight is
 *                 read from VRAM at its small STORAGE width but is usually
 *                 dequantized to a wider type before the actual multiply --
 *                 see PRECISION_MAP for which.
 *   bandwidthGBs: memoryBandwidthGBs from the unit.
 *   activeParams: parameters actually read AND computed per token -- every
 *                 weight for a dense model, only the routed experts for MoE.
 *   bytesPerParam: bytes read from VRAM per parameter per token, i.e. the
 *                 STORAGE format's width (bpw / 8), regardless of what the
 *                 compute precision above is.
 *   batchSize:    tokens processed per weight-read. Decode is 1 (the
 *                 classic autoregressive step). Prefill defaults to 512,
 *                 matching this page's own pp512 anchor convention -- one
 *                 weight read serves the whole batch, which is exactly why
 *                 prefill throughput rises with batch size while decode does
 *                 not.
 *
 * Returns tokensPerSec = null (not NaN/Infinity) when any input is missing,
 * so a caller can render an em dash instead of a broken number.
 */
export function theoreticalMax({ opsPerSec, bandwidthGBs, activeParams, bytesPerParam, batchSize }) {
  if (!opsPerSec || !bandwidthGBs || !activeParams || !bytesPerParam || !batchSize) {
    return { tokensPerSec: null, bound: null, computeTimeS: null, bandwidthTimeS: null };
  }
  // 2 FLOPs (one multiply + one add) per parameter per token -- the standard
  // transformer forward-pass approximation, excluding attention's own
  // O(n^2) term (see the file header for why that's a safe omission here).
  const flopsTotal = 2 * activeParams * batchSize;
  const computeTimeS = flopsTotal / (opsPerSec * 1e12);

  const bytesTotal = activeParams * bytesPerParam;
  const bandwidthTimeS = bytesTotal / (bandwidthGBs * 1e9);

  const timeS = Math.max(computeTimeS, bandwidthTimeS);
  return {
    tokensPerSec: batchSize / timeS,
    bound: computeTimeS >= bandwidthTimeS ? 'compute' : 'bandwidth',
    computeTimeS,
    bandwidthTimeS,
  };
}

/**
 * A platform's aggregate rated ops/sec and bandwidth at one precision,
 * summed across its composition -- the same "sum from the catalog, never
 * store a total" rule data.js already applies to cost/power/capacity.
 * Multi-card platforms (v100 x4, b70 x4) sum linearly here, which is
 * optimistic (real multi-GPU scaling is never perfectly linear) -- so this
 * makes the ceiling MORE generous for those rows, never less, consistent
 * with the whole model being an upper bound rather than a point estimate.
 * Returns null for a field with no data on any composition unit, so a
 * caller can render a gap instead of a silent zero.
 */
export function platformComputeRate(platform, unitById, precision) {
  let opsPerSec = 0, bandwidthGBs = 0, anyOps = false, anyBw = false;
  for (const c of platform.composition ?? []) {
    const u = unitById[c.unit];
    if (!u) continue;
    const ops = u.compute?.values?.[precision];
    if (ops != null) { opsPerSec += ops * c.count; anyOps = true; }
    if (u.memoryBandwidthGBs != null) { bandwidthGBs += u.memoryBandwidthGBs * c.count; anyBw = true; }
  }
  return { opsPerSec: anyOps ? opsPerSec : null, bandwidthGBs: anyBw ? bandwidthGBs : null };
}

/**
 * Same aggregation as platformComputeRate, but resolves the compute
 * precision PER COMPOSITION UNIT from dequant-map.js's grounded
 * quant-family x architecture-family findings, rather than taking one fixed
 * precision string for the whole platform. Matters because which precision
 * a quant executes at is architecture-dependent (see
 * docs/roofline-dequant-paths.md) -- a fixed-precision call would silently
 * assume every unit in a mixed platform shares one answer.
 *
 * quantFamily === null models an unquantized baseline (plain fp16/fp8) --
 * every unit uses that precision directly, no dequant-path lookup needed.
 *
 * Returns rates plus perUnitResolution, the list of what was actually
 * assumed per unit (grounded or not), so a caller can show its work.
 */
export function platformComputeRateForQuant(platform, unitById, quantFamily, basePrecision) {
  let opsPerSec = 0, bandwidthGBs = 0, anyOps = false, anyBw = false;
  const perUnitResolution = [];
  for (const c of platform.composition ?? []) {
    const u = unitById[c.unit];
    if (!u) continue;
    const resolved = quantFamily == null
      ? { precision: basePrecision, confidence: 'm', note: 'unquantized baseline', archFamily: null, grounded: true }
      : dequantPrecisionFor(quantFamily, c.unit);
    perUnitResolution.push({ unit: c.unit, ...resolved });
    const ops = u.compute?.values?.[resolved.precision];
    if (ops != null) { opsPerSec += ops * c.count; anyOps = true; }
    if (u.memoryBandwidthGBs != null) { bandwidthGBs += u.memoryBandwidthGBs * c.count; anyBw = true; }
  }
  return {
    opsPerSec: anyOps ? opsPerSec : null,
    bandwidthGBs: anyBw ? bandwidthGBs : null,
    perUnitResolution,
  };
}

export const PREFILL_BATCH = 512; // matches this page's own pp512 anchor convention
export const DECODE_BATCH = 1;

/**
 * The pair a reader actually wants: theoretical [prefill, decode] ceilings
 * for one unit at one chosen compute precision and storage width.
 */
export function theoreticalPrefillDecode({ opsPerSec, bandwidthGBs, activeParams, bytesPerParam }) {
  const args = { opsPerSec, bandwidthGBs, activeParams, bytesPerParam };
  return {
    prefill: theoreticalMax({ ...args, batchSize: PREFILL_BATCH }),
    decode: theoreticalMax({ ...args, batchSize: DECODE_BATCH }),
  };
}

/**
 * How wrong a measured value would have to be to flag it. Ratios, not a
 * statistical sigma -- there usually aren't enough repeated measurements
 * per cell for a real standard deviation, and a roofline ceiling is a hard
 * physical bound, not a distribution to sit within.
 *
 *   impossible:  measured > ceiling * this. The ceiling already assumes
 *                perfect (100%) utilization, so exceeding it even by a
 *                little means the modeling inputs are wrong somewhere
 *                (wrong quant, wrong param count, wrong bandwidth) or the
 *                measurement itself is. 1.05 gives 5% slack for rounding
 *                and the bpw table's own 'e'-confidence approximations.
 *   suspiciousLow: measured < ceiling * this is not a contradiction --
 *                real hardware is often well under the ceiling -- but
 *                worth a second look alongside the note's stated engine
 *                and quant, since it can also mean the compute-precision
 *                assumption is more optimistic than what actually ran.
 */
export const OUTLIER_THRESHOLDS = { impossible: 1.05, suspiciousLow: 0.15 };

/**
 * Classifies one measured tokens/sec value against its modeled ceiling.
 * Returns null (not classifiable) when either input is missing -- silence,
 * not a false "fine".
 */
export function classifyAgainstCeiling(measuredTps, ceilingTps) {
  if (measuredTps == null || ceilingTps == null || !(ceilingTps > 0)) return null;
  const ratio = measuredTps / ceilingTps;
  if (ratio > OUTLIER_THRESHOLDS.impossible) return { ratio, verdict: 'impossible' };
  if (ratio < OUTLIER_THRESHOLDS.suspiciousLow) return { ratio, verdict: 'suspicious-low' };
  return { ratio, verdict: 'plausible' };
}
