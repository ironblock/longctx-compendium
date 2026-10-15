// What the hardware allows for one model, before any software is involved.
//
// Every function here is a pure function of catalog facts (a unit's bandwidth,
// capacity and rated throughput) and model-shape facts (assets/models.js, read
// from each model's published config.json). Nothing here reads a benchmark.
// Observations are compared against these numbers; they never feed them.
//
// The two ceilings are not equally useful, and the page says so:
//
//   Decode (one stream, one token per pass) is bound by memory bandwidth. Each
//   step must read every active weight once, the whole KV cache of every
//   full-attention layer, the window of every sliding-window layer, and the
//   recurrent state of every linear-attention layer. That makes it a tight,
//   honest upper bound, and the one that moves with context depth.
//
//   Prefill is bound by rated matrix throughput at the precision the engine
//   actually multiplies in. Real prefill sits far below it -- attention
//   kernels, MoE routing, small expert GEMMs and batch scheduling all cost --
//   so it bounds what is possible without predicting what is likely.
//
// Both stay upper bounds by leaning generous wherever a choice exists: perfect
// overlap, perfect multi-card scaling, no kernel-launch or synchronization
// cost, and only the bytes a step cannot avoid reading.

import { MODELS } from './models.js';
import { PRECISION_MAP, ARCH_TO_DEQUANT_FAMILY } from './dequant-map.js';

/** Bytes per cached element, for every KV cache type a line on this page uses. */
export const KV_BYTES_PER_ELEMENT = {
  f32: 4,
  f16: 2,
  bf16: 2,
  fp8: 1,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  // ExLlamaV3 cache_mode "k,v" is a bit width per tensor; nominal, scales not counted.
  '8bit': 1,
  '5bit': 5 / 8,
  '4bit': 4 / 8,
};

/** KV formats the calculator offers. */
export const KV_CHOICES = [
  { id: 'f16', label: 'F16 / BF16' },
  { id: 'q8_0', label: 'Q8_0' },
  { id: 'q4_0', label: 'Q4_0' },
];

/**
 * Weight formats: storage width (bits per weight, scales included) and the
 * family that decides which matrix precision an engine multiplies in.
 *
 * Block types are exact (from the struct layouts in ggml-common.h). Named GGUF
 * recipes (Q4_K_M ...) mix block types per tensor role, so their width is a
 * typical average and depends on the model -- confidence 'e'. A line that
 * records its own measured bpw always wins over these.
 *
 *   q4_k / q5_k / q6_k / q8_0 / mxfp4 / nvfp4: ggml-common.h block sizes
 *   mlx 4-bit: 4-bit codes + an fp16 scale and bias per 64-weight group
 */
export const WEIGHT_FORMATS = {
  q4_k_m: { label: 'Q4_K_M', bpw: 4.83, confidence: 'e', family: 'kquant', note: 'GGUF recipe: Q4_K with Q6_K for some tensors; a typical average' },
  q4_k_xl: { label: 'UD-Q4_K_XL', bpw: null, confidence: 'i', family: 'kquant', note: 'Unsloth dynamic recipe; width varies by model and is not recorded here' },
  q5_k_m: { label: 'Q5_K_M', bpw: 5.69, confidence: 'e', family: 'kquant', note: 'GGUF recipe; a typical average' },
  q6_k: { label: 'Q6_K', bpw: 6.5625, confidence: 'm', family: 'kquant', note: 'ggml block_q6_K: (2+16+192) B per 256 weights' },
  q8_0: { label: 'Q8_0', bpw: 8.5, confidence: 'm', family: 'legacy8bit', note: 'ggml block_q8_0: 34 B per 32 weights' },
  // The dispatch research groups the legacy quants with Q8_0 ("Legacy/K-quants
  // ... execute at INT8"), so Q4_0 shares its family.
  q4_0: { label: 'Q4_0', bpw: 4.5, confidence: 'm', family: 'legacy8bit', note: 'ggml block_q4_0: 18 B per 32 weights' },
  q3_k_m: { label: 'Q3_K_M', bpw: 3.91, confidence: 'e', family: 'kquant', note: 'GGUF recipe; a typical average' },
  iq: { label: 'IQ-series', bpw: null, confidence: 'i', family: 'iq', note: 'width depends on the IQ type and recipe' },
  mxfp4: { label: 'MXFP4', bpw: 4.25, confidence: 'm', family: 'mxfp4', note: 'ggml block_mxfp4: 17 B per 32 weights' },
  nvfp4: { label: 'NVFP4', bpw: 4.5, confidence: 'm', family: 'nvfp4', note: 'ggml block_nvfp4: 36 B per 64 weights' },
  mlx4: { label: 'MLX 4-bit', bpw: 4.5, confidence: 'e', family: 'mlx', note: 'MLX default: group size 64 with an fp16 scale and bias per group' },
  exl3: { label: 'EXL3', bpw: null, confidence: 'i', family: 'exl3', note: 'ExLlamaV3 trellis quant; the line records its own bpw' },
  fp8: { label: 'FP8 checkpoint', bpw: 8, confidence: 'm', family: 'fp8', note: 'one byte per weight, as served from safetensors by vLLM and similar' },
  bf16: { label: 'BF16 / FP16', bpw: 16, confidence: 'm', family: 'bf16', note: 'unquantized' },
};

/** Weight formats the calculator offers, in the order shown. */
export const WEIGHT_CHOICES = ['q4_k_m', 'q8_0', 'mxfp4', 'nvfp4', 'fp8', 'bf16'];

export const DEPTH_CHOICES = [4096, 32768, 131072, 262144];

/**
 * Per-card working memory an engine needs beyond weights and cache (runtime
 * context, activations, workspaces). Real engines vary from well under this to
 * several times it; one GiB keeps "fits" from being declared on a card filled
 * to the last byte without pretending to model any particular engine.
 */
export const RESERVE_BYTES_PER_CARD = 2 ** 30;

const GiB = 2 ** 30;

// --- Model shape ------------------------------------------------------------

export const modelById = id => MODELS[id] ?? null;

/** full | sliding | linear -- what decides how a model's decode cost grows with depth. */
export function attentionLayout(m) {
  const t = m.layerTypes;
  if (t.linear_attention) return 'linear';
  if (t.sliding_attention) return 'sliding';
  return 'full';
}

export const LAYOUT_LABEL = {
  full: 'Full attention on every layer',
  sliding: 'Sliding-window + full attention',
  linear: 'Linear (recurrent) + full attention',
};

/**
 * Attention shape of one layer type. Most models use one shape everywhere;
 * Gemma 4 gives its full-attention layers fewer, wider KV heads than its
 * sliding layers, and shares one projection for keys and values there.
 */
function attnShape(m, type) {
  const o = m.attention?.[type] ?? {};
  return {
    heads: o.heads ?? m.heads,
    kvHeads: o.kvHeads ?? m.kvHeads,
    headDim: o.headDim ?? m.headDim,
    tensors: o.keysEqualValues ? 1 : 2,
  };
}

/**
 * Cached elements per position on one layer of a type, split into the K and V
 * parts so each can carry its own cache format. MLA (GLM-4.7-Flash) caches one
 * compressed latent plus a rotary key per position, shared by every head.
 */
function kvElements(m, type) {
  if (m.mla && type === 'full') return { k: m.mla.kvLoraRank + m.mla.ropeDim, v: 0 };
  const s = attnShape(m, type);
  return { k: s.kvHeads * s.headDim, v: s.tensors === 2 ? s.kvHeads * s.headDim : 0 };
}

function kvBytesPerPosition(m, type, k, v) {
  const bk = KV_BYTES_PER_ELEMENT[k];
  const bv = KV_BYTES_PER_ELEMENT[v];
  if (bk == null || bv == null) return null;
  const e = kvElements(m, type);
  return e.k * bk + e.v * bv;
}

/**
 * Positions one layer of a type attends over at a depth. A sliding layer sees
 * at most its window. A block-sparse layer (Qwen3.8-Flash-Next's "full"
 * layers) selects at most its budget of positions, though it still stores
 * all of them.
 */
function attended(m, type, depth) {
  if (type === 'sliding') return Math.min(depth, m.slidingWindow ?? depth);
  return Math.min(depth, m.sparse?.budget ?? depth);
}

/** KV bytes held for one sequence at a depth -- what has to fit. null for an unknown cache type. */
export function kvBytesAt(m, depth, k = 'f16', v = k) {
  const full = kvBytesPerPosition(m, 'full', k, v);
  const slide = kvBytesPerPosition(m, 'sliding', k, v);
  if (full == null) return null;
  return (m.layerTypes.full_attention ?? 0) * full * depth + (m.layerTypes.sliding_attention ?? 0) * slide * Math.min(depth, m.slidingWindow ?? depth);
}

/** KV bytes one decode step has to read at a depth -- what bandwidth pays for. */
export function kvReadBytesAt(m, depth, k = 'f16', v = k) {
  const full = kvBytesPerPosition(m, 'full', k, v);
  const slide = kvBytesPerPosition(m, 'sliding', k, v);
  if (full == null) return null;
  return (m.layerTypes.full_attention ?? 0) * full * attended(m, 'full', depth) + (m.layerTypes.sliding_attention ?? 0) * slide * attended(m, 'sliding', depth);
}

/** KV bytes per token of context on the full-attention layers -- the slope of the cache. */
export function kvBytesPerToken(m, k = 'f16', v = k) {
  const full = kvBytesPerPosition(m, 'full', k, v);
  return full == null ? null : (m.layerTypes.full_attention ?? 0) * full;
}

/**
 * Recurrent state per sequence across the linear-attention layers. An estimate:
 * one [keyHeadDim x valueHeadDim] matrix per value head per layer (for Mamba-2,
 * [state size x head size] per head), held at `bytesPerElement` (f32 by
 * default), short convolution state left out.
 */
export function recurrentStateBytes(m, bytesPerElement = 4) {
  if (!m.linear || !m.layerTypes.linear_attention) return 0;
  const { valueHeads, keyHeadDim, valueHeadDim } = m.linear;
  return m.layerTypes.linear_attention * valueHeads * keyHeadDim * valueHeadDim * bytesPerElement;
}

/** Bits per weight for a weight-format key, or a line's own recorded figure. */
export function bpwOf(formatKey, recordedBpw) {
  if (recordedBpw != null) return { bpw: recordedBpw, confidence: 'm', source: 'recorded on the line' };
  const f = WEIGHT_FORMATS[formatKey];
  if (f?.bpw == null) return { bpw: null, confidence: null, source: f ? f.note : 'weight format not recorded' };
  return { bpw: f.bpw, confidence: f.confidence, source: f.note };
}

/**
 * Parameters a token actually has to touch. A decode step reads one row of an
 * untied input embedding, not the table, so the table comes out; a tied one is
 * also the output head and is read in full. Taking it out even where a model
 * card's "active" count may already exclude it can only loosen the bound.
 */
export const readParams = m => m.params.active - (m.params.tiedEmbeddings ? 0 : (m.params.inputEmbedding ?? 0));

/** Most engines need the attention heads to divide evenly across tensor-parallel cards. */
export const splitsEvenly = (m, cards) => cards === 1 || m.heads % cards === 0;

// --- Decode -----------------------------------------------------------------

/**
 * Bytes one decode step must read, for `streams` sequences each `depth` deep.
 * Weights are read once per step whatever the stream count; cache and state
 * are per sequence.
 */
export function decodeBytesPerStep(m, { bpw, depth, kvK = 'f16', kvV = kvK, streams = 1 }) {
  if (!m?.params?.active || bpw == null) return null;
  const weights = (readParams(m) * bpw) / 8;
  const kv = kvReadBytesAt(m, depth, kvK, kvV);
  if (kv == null) return null;
  const state = recurrentStateBytes(m);
  return { weights, kv: kv * streams, state: state * streams, total: weights + (kv + state) * streams };
}

/** Bandwidth a decode step can draw on: every card's under tensor parallel, one card's under a layer split. */
export function decodeBandwidthGBs(unit, cards, mode) {
  if (!unit?.memoryBandwidthGBs) return null;
  return mode === 'tensor' ? unit.memoryBandwidthGBs * cards : unit.memoryBandwidthGBs;
}

/**
 * Decode ceiling in tokens/sec. Per stream unless `basis` is 'aggregate'.
 * A layer split runs one card at a time for a single sequence, so it gets one
 * card's bandwidth however many cards hold the model.
 */
export function decodeCeiling(m, unit, { cards = 1, mode = 'single', bpw, depth, kvK, kvV, streams = 1, basis = 'per-stream' }) {
  const bytes = decodeBytesPerStep(m, { bpw, depth, kvK, kvV, streams });
  const bw = decodeBandwidthGBs(unit, cards, mode);
  if (!bytes || !bw) return null;
  const stepsPerSec = (bw * 1e9) / bytes.total;
  return { tps: basis === 'aggregate' ? stepsPerSec * streams : stepsPerSec, bytes, bandwidthGBs: bw };
}

// --- Prefill ----------------------------------------------------------------

/** Mean number of cached positions a prompt's tokens attend over, for a window (Infinity = full). */
function meanAttended(promptTokens, window = Infinity) {
  const P = promptTokens;
  if (P <= 0) return 0;
  if (P <= window) return P / 2;
  // Positions below the window attend to themselves so far; the rest to a full window.
  return (window * window / 2 + (P - window) * window) / P;
}

/**
 * Matrix FLOPs per token at a context: 2 per active weight, plus attention's
 * QK^T and AV (4 x heads x headDim per attended position on a softmax layer)
 * and a linear layer's state update and readout.
 *
 * `cold` gives the mean over a prompt evaluated from empty; otherwise the cost
 * of one more token appended at `depth`.
 */
export function prefillFlopsPerToken(m, depth, { cold = false } = {}) {
  if (!m?.params?.active) return null;
  const t = m.layerTypes;
  // Mean positions a token attends over: half the prompt for a cold one (within
  // a window or budget), all of them for one appended at depth.
  const span = (type, cap) => (cold ? meanAttended(depth, cap) : attended(m, type, depth));
  const per = type => 4 * attnShape(m, type).heads * attnShape(m, type).headDim;
  const softmax =
    (t.full_attention ?? 0) * per('full') * span('full', m.sparse?.budget ?? Infinity) +
    (t.sliding_attention ?? 0) * per('sliding') * span('sliding', m.slidingWindow ?? Infinity);
  const linear = m.linear && t.linear_attention
    ? 4 * t.linear_attention * m.linear.valueHeads * m.linear.keyHeadDim * m.linear.valueHeadDim
    : 0;
  return 2 * readParams(m) + softmax + linear;
}

/**
 * The matrix precision a weight format actually multiplies in on a unit.
 * GGUF families follow llama.cpp's own kernel dispatch (assets/dequant-map.js);
 * an FP8 checkpoint runs in FP8 only where the silicon has FP8 matrix units and
 * is upcast to 16-bit elsewhere; unquantized weights run in BF16 where native.
 * Anything ungrounded falls back to FP16 and says so.
 */
export function computePrecision(unit, formatKey) {
  const family = WEIGHT_FORMATS[formatKey]?.family ?? null;
  const fmt = unit.formats ?? {};
  if (family === 'fp8') {
    return fmt.fp8 === 'native'
      ? { precision: 'fp8', grounded: true, note: 'FP8 checkpoint on FP8 matrix units' }
      : { precision: 'fp16', grounded: true, note: 'no FP8 matrix units: weights upcast to 16-bit' };
  }
  if (family === 'bf16') {
    // An unquantized checkpoint may be FP16 or BF16; an upper bound takes the
    // faster of the two the card's matrix units take natively.
    const v = unit.compute?.values ?? {};
    const native = ['bf16', 'fp16'].filter(p => fmt[p] === 'native' && v[p] != null);
    const best = native.sort((a, b) => v[b] - v[a])[0];
    return best
      ? { precision: best, grounded: true, note: `16-bit weights at the faster of this card's native FP16 and BF16 rates (${best.toUpperCase()})` }
      : { precision: 'fp16', grounded: false, note: 'no rated native 16-bit matrix figure: FP16 assumed' };
  }
  const dq = ARCH_TO_DEQUANT_FAMILY[unit.arch];
  const entry = family && dq ? PRECISION_MAP[family]?.[dq.family] : null;
  if (entry) {
    // The kernel finding is per generation; a card whose own support for that
    // precision is unconfirmed (B300's INT8) cannot borrow it.
    if (fmt[entry.precision] && fmt[entry.precision] !== 'native') {
      return {
        precision: 'fp16',
        grounded: false,
        note: `llama.cpp would use ${entry.precision.toUpperCase()} on ${dq.family}, but this card's ${entry.precision.toUpperCase()} support is ${fmt[entry.precision] === 'absent' ? 'absent' : 'unconfirmed'}; FP16 assumed`,
      };
    }
    return {
      precision: entry.precision,
      grounded: !dq.approximate,
      note: entry.note + (dq.approximate ? ` (${unit.arch} read as ${dq.family}: ${dq.approximate})` : ''),
    };
  }
  return {
    precision: 'fp16',
    grounded: false,
    note: `no grounded kernel finding for ${WEIGHT_FORMATS[formatKey]?.label ?? 'this format'} on ${unit.archLabel ?? unit.arch ?? 'this chip'}; FP16 assumed`,
  };
}

/**
 * Prefill ceiling in tokens/sec. Under either split the cards can work at
 * once (tensor parallel directly, a layer split by pipelining batches), so the
 * bound is every card's throughput -- generous, as an upper bound should be.
 */
export function prefillCeiling(m, unit, { cards = 1, formatKey, depth, cold = false }) {
  const flops = prefillFlopsPerToken(m, depth, { cold });
  let prec = computePrecision(unit, formatKey);
  let key = prec.precision;
  let ops = unit.compute?.values?.[key];
  if (ops == null) {
    const v = vectorBound(unit);
    if (v) {
      prec = { precision: v.precision, vector: true, grounded: true, note: `no matrix units: the fastest rate on the shader ALUs (${v.precision.toUpperCase()}) bounds any kernel` };
      key = `${v.precision}:vector`;
      ops = v.ops;
    }
  }
  // A ceiling resting on a figure the vendor never published says so.
  if (ops != null && unit.compute?.unofficial?.includes(key)) prec = { ...prec, unofficial: true };
  if (!flops || ops == null) return { tps: null, precision: prec, flopsPerToken: flops };
  return { tps: (ops * 1e12 * cards) / flops, precision: prec, flopsPerToken: flops, opsPerSec: ops * cards };
}

/**
 * A card with no matrix units at all multiplies on its shader ALUs (packed
 * FP16, dot-product INT8), so whichever path a kernel takes, the fastest of
 * those rates bounds it. A card with any matrix path, or one whose formats
 * are unknown, gets no such fallback: its matrix units may be faster.
 */
export function vectorBound(unit) {
  const fmt = Object.values(unit.formats ?? {});
  if (!fmt.length || fmt.some(s => s !== 'absent')) return null;
  const vec = Object.entries(unit.compute?.values ?? {})
    .filter(([k]) => k.endsWith(':vector'))
    .sort((a, b) => b[1] - a[1]);
  return vec.length ? { precision: vec[0][0].slice(0, -':vector'.length), ops: vec[0][1] } : null;
}

// --- Capacity ---------------------------------------------------------------

/**
 * Whether weights, cache and state fit across `cards` units, after a fixed
 * per-card reserve. Catalog memory sizes are read as GiB, which is what vendors
 * mean by "32 GB" of VRAM. Under tensor parallel a model with fewer KV heads
 * than cards has to replicate them, so the cache grows by that factor.
 */
export function fit(m, unit, { cards = 1, mode = 'single', bpw, depth, kvK = 'f16', kvV = kvK, streams = 1 }) {
  if (!m?.params?.total || bpw == null || !unit?.memoryGB) return null;
  const weights = (m.params.total * bpw) / 8;
  const full = kvBytesPerPosition(m, 'full', kvK, kvV);
  const slide = kvBytesPerPosition(m, 'sliding', kvK, kvV);
  if (full == null) return null;
  // Under tensor parallel each card holds the heads it computes, so a layer type
  // with fewer KV heads than cards is copied onto the rest. MLA's compressed
  // cache is one latent shared by every head, so every card holds all of it.
  const copies = type => {
    if (mode !== 'tensor') return 1;
    if (type === 'full' && m.mla) return cards;
    return Math.max(1, cards / attnShape(m, type).kvHeads);
  };
  const fullKv = (m.layerTypes.full_attention ?? 0) * full * depth;
  const slideKv = (m.layerTypes.sliding_attention ?? 0) * slide * Math.min(depth, m.slidingWindow ?? depth);
  const kv = fullKv * copies('full') + slideKv * copies('sliding');
  const replicate = Math.max(copies('full'), (m.layerTypes.sliding_attention ? copies('sliding') : 1));
  const need = weights + streams * (kv + recurrentStateBytes(m));
  const have = cards * (unit.memoryGB * GiB - RESERVE_BYTES_PER_CARD);
  return { need, have, fits: need <= have, weights, kv: kv * streams, replicate };
}

export const CARD_STEPS = [1, 2, 4, 8];

/** The fewest cards (1, 2, 4 or 8) that hold the model at this depth, or null. */
export function cardsToFit(m, unit, args) {
  for (const n of CARD_STEPS) {
    const f = fit(m, unit, { ...args, cards: n });
    if (f == null) return null;
    if (f.fits) return n;
  }
  return null;
}

export const fmtGiB = b => (b == null ? '—' : b >= 10 * GiB ? `${Math.round(b / GiB)} GiB` : `${(b / GiB).toFixed(1)} GiB`);

// --- Observations against their ceilings ------------------------------------

/**
 * The ceiling an observed point sits under, or the reason there isn't one.
 * A reason is always given rather than a silent blank: a reader deciding how
 * far to trust a row needs to know whether "no ceiling" means "unknowable"
 * or "nobody recorded the quant".
 */
/**
 * A stand-in shape for a line whose source gave only a size ("a 27B dense
 * model"): weights only, no cache counted, which can only raise the bound.
 */
const weightsOnly = p => ({
  label: 'the model as labelled',
  params: { total: p.total, active: p.active ?? p.total },
  layerTypes: { full_attention: 0 },
  heads: 1,
  kvHeads: 1,
  headDim: 1,
});

export function ceilingFor(line, point, unitById) {
  const m = modelById(line.model) ?? (line.model == null && line.modelParams ? weightsOnly(line.modelParams) : null);
  if (!m) return { why: line.model ? `no shape recorded for ${line.model}` : 'the model was not recorded' };
  if (!m.params?.active) return { why: `no parameter count recorded for ${m.label}` };

  const kinds = [...new Set(line.rig.units.map(u => u.unit))];
  if (kinds.length !== 1) return { why: 'mixed cards: no single ceiling' };
  const unit = unitById[kinds[0]];
  const cards = line.rig.units.reduce((n, u) => n + u.count, 0);
  const mode = cards === 1 ? 'single' : line.parallel?.mode;
  if (!mode) return { why: `${cards} cards, but the split (tensor or layer) was not recorded` };

  const { bpw } = bpwOf(line.quant.key, line.quant.bpw);
  if (bpw == null) return { why: `bits per weight not recorded for ${line.quant.format}` };

  if (point.metric === 'decode') {
    const kvK = line.kvCache?.k ?? 'f16';
    const kvV = line.kvCache?.v ?? kvK;
    const c = decodeCeiling(m, unit, { cards, mode, bpw, depth: point.depth, kvK, kvV, streams: point.streams, basis: point.basis });
    if (!c) return { why: 'no bandwidth or cache figure to compute from' };
    const specOn = !!line.spec && line.spec.method !== 'none' && point.spec !== 'off';
    return {
      tps: c.tps,
      bound: 'bandwidth',
      speculative: specOn,
      assumedKv: !line.kvCache && !!modelById(line.model),
      weightsOnly: !modelById(line.model),
      bytes: c.bytes,
    };
  }
  if (point.metric === 'prefill') {
    const p = prefillCeiling(m, unit, { cards, formatKey: line.quant.key, depth: point.depth, cold: point.prefillBasis === 'cold' });
    if (p.tps == null) return { why: `no rated ${p.precision.precision.toUpperCase()} throughput for ${unit.label}` };
    return { tps: p.tps, bound: 'compute', precision: p.precision };
  }
  return { why: `no ceiling for ${point.metric}` };
}

/** One-sentence reading of an observed/ceiling ratio. */
export function ratioOf(value, ceiling) {
  if (value == null || !(ceiling > 0)) return null;
  return value / ceiling;
}
