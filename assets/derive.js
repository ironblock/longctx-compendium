// Everything computed from the data rather than stored in it. Derived values
// are deliberately never written back to compendium.json -- the data file holds
// only what was measured, modeled, or paid, so a cost or decode-rate edit can
// never disagree with a stale precomputed ratio.

export const NO_DATA = 'n';

/** Confidence codes render identically for primary and secondary measurements. */
export const cssConf = c => (c === 'm~' ? 'm' : c);

export function platColor(model, id, alpha = 1) {
  const p = model.PLAT.find(x => x.id === id);
  if (!p) return '#888';
  return alpha === 1 ? p.color : hexA(p.color, alpha);
}

/**
 * Units don't carry their own display.color the way platforms/builds do --
 * there can be dozens of them and most are never charted together outside this
 * one view -- so the precision chart colors by vendor instead. Kept to four
 * entries deliberately; a fifth vendor falls back to muted gray rather than
 * growing this list ad hoc.
 */
export const VENDOR_COLOR = { NVIDIA: '#76b900', AMD: '#ff5252', Intel: '#37d6c6', Apple: '#ce93d8' };
export const vendorColor = (vendor, alpha = 1) => {
  const hex = VENDOR_COLOR[vendor] ?? '#8898a9';
  return alpha === 1 ? hex : hexA(hex, alpha);
};

// Widest-to-narrowest, so the columns/toggles read the way a datasheet does.
export const PRECISION_ORDER = ['fp64', 'fp32', 'tf32', 'bf16', 'fp16', 'fp8', 'fp4', 'int8', 'int4'];

/**
 * Which precisions any unit in the catalog has a figure for, dense or sparse,
 * ordered canonically with anything the catalog has never seen before tacked
 * on the end. Shared between the spec table's columns and the precision
 * chart's toggle so the two can never disagree about what's available.
 */
export function discoveredPrecisions(units) {
  const seen = new Set(units.flatMap(u => Object.keys(u.compute?.values ?? {})));
  return [
    ...PRECISION_ORDER.filter(p => seen.has(p) || seen.has(`${p}:sparse`)),
    ...[...seen].map(k => k.replace(':sparse', '')).filter(p => !PRECISION_ORDER.includes(p)),
  ].filter((p, i, a) => a.indexOf(p) === i);
}

/**
 * Units carrying a figure for one precision, dense and/or its 2:4-sparse
 * twin, sorted richest first. A unit with neither is left out entirely --
 * this is a chart, not a table, so there is no cell to leave blank instead.
 */
export function precisionRows(units, precision) {
  return units
    .map(u => ({
      u,
      dense: u.compute?.values?.[precision] ?? null,
      sparse: u.compute?.values?.[`${precision}:sparse`] ?? null,
    }))
    .filter(r => r.dense != null || r.sparse != null)
    .sort((a, b) => (b.dense ?? b.sparse) - (a.dense ?? a.sparse));
}

/** INT precisions are rated in TOPS, everything else here is a FLOPS unit. */
export const precisionUnitLabel = p => (p.startsWith('int') ? 'TOPS' : 'TFLOPS');

export function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function fmtT(s) {
  if (!s) return '—';
  return s < 90 ? s.toFixed(1) + 's' : (s / 60).toFixed(1) + 'm';
}

export function ttBand(s) {
  if (!s) return '';
  return s <= 30 ? 't-ok' : s <= 120 ? 't-warn' : 't-bad';
}

export const idleYr = (model, w) => (w * 8760) / 1000 * model.KWH;

// The one depth at which this page has any second decode measurement.
export const DECODE_ANCHOR_CTX = 32768;

/**
 * Decode rate at a given context depth.
 *
 * Decode is not flat with depth. Every generated token reads the whole KV
 * cache, so a bandwidth-bound decode slows as the session grows -- this page's
 * own data has it falling 29-53% between the short-context rate and 32K
 * (5090 MoE: 234 -> 110.7 t/s). Pricing a 16K-deep turn's generation at the
 * short-context rate, which is what this used to do, understates every turn it
 * describes.
 *
 * Interpolation is linear in SECONDS PER TOKEN, not in tokens/sec: KV-cache
 * bytes read per token grow linearly with depth, so time per token is the
 * quantity that moves linearly. Interpolating the rate directly would bend the
 * wrong way and flatter deep contexts -- exactly the bias being corrected.
 *
 * Only five of this page's 24 decode entries have a 32K measurement at all,
 * and none has one deeper. Where there is nothing to interpolate against, the
 * short-context rate is still returned but marked `shortOnly`, so "we know
 * this decays and measured it" stays distinct from "we have one number and are
 * using it everywhere".
 */
export function decodeAtDepth(tg, atCtx = 0) {
  if (!tg?.v) return { v: null, basis: 'none', est: true };
  if (!(atCtx > 0)) return { v: tg.v, basis: 'measured', est: tg.c !== 'm' };
  if (tg.v32 == null) return { v: tg.v, basis: 'shortOnly', est: true };
  if (atCtx === DECODE_ANCHOR_CTX) return { v: tg.v32, basis: 'measured', est: tg.c32 !== 'm' };

  const t0 = 1 / tg.v;
  const t = t0 + ((1 / tg.v32 - t0) * atCtx) / DECODE_ANCHOR_CTX;
  // A non-positive time would mean the two anchors imply decode reaching
  // infinite speed at this depth -- measurement noise, not a result.
  if (!(t > 0)) return { v: tg.v, basis: 'shortOnly', est: true };
  return {
    v: 1 / t,
    basis: atCtx < DECODE_ANCHOR_CTX ? 'interpolated' : 'extrapolated',
    est: true,
  };
}

/** How many platforms are running on a short-context rate with no depth anchor. */
export function decodeBasisTally(model, arch, atCtx) {
  const tally = { measured: 0, interpolated: 0, extrapolated: 0, shortOnly: 0, none: 0 };
  for (const p of model.PLAT) tally[decodeAtDepth(model.TG[arch][p.id], atCtx).basis]++;
  return tally;
}

/**
 * Wall-clock for one representative agentic turn: a 16K-token prompt prefilled
 * cold, then 2K tokens generated. Flagged estimated unless BOTH the 16K prefill
 * point and the depth-adjusted decode rate are primary measurements.
 *
 * Generation happens with the prompt already in the cache, so the decode rate
 * is taken at `promptTokens` deep rather than at zero.
 */
export function computeWC(model, arch, promptTokens = 16384, genTokens = 2048) {
  const idx = model.CTX.indexOf(promptTokens);
  return model.PLAT.map(p => {
    const pp = model.PP[arch][p.id];
    const dec = decodeAtDepth(model.TG[arch][p.id], promptTokens);
    const ppV = idx >= 0 ? pp.v[idx] : null;
    const ppC = idx >= 0 ? pp.c[idx] : NO_DATA;
    if (!ppV || !dec.v) return { id: p.id, ttft: null, gen: null, total: null, est: true, decode: dec };
    const ttft = promptTokens / ppV;
    const gen = genTokens / dec.v;
    return { id: p.id, ttft, gen, total: ttft + gen, est: ppC !== 'm' || dec.est, decode: dec };
  });
}

export const wcById = (model, arch) =>
  Object.fromEntries(computeWC(model, arch).map(x => [x.id, x]));

/**
 * The cold wall-clock above answers "what does a session START, a cache
 * eviction, or a mid-prefix edit cost" -- not "what does turn 50 of an
 * otherwise-untouched session cost". An active session's KV cache stays hot
 * turn to turn, so nothing re-prefills the existing context. But caching only
 * erases the cost of the PAST: for full/quadratic attention, each newly
 * appended token still has to attend across the entire existing cache, so the
 * marginal cost of the next turn keeps growing with session depth even
 * though nothing is literally re-prefilled. That growth is exactly the slope
 * of the cold prefill curve -- this derives it by differencing cumulative
 * time (tokens / pp) between consecutive context checkpoints, rather than
 * needing a separate "incremental append" benchmark that doesn't exist.
 * Linear/hybrid-attention architectures (Mamba2, Gated DeltaNet) are the
 * thing that actually escapes this scaling -- see the Strix Halo note.
 */
export function marginalSegments(model, arch, platId) {
  const pp = model.PP[arch][platId];
  const segments = [];
  for (let i = 0; i < model.CTX.length - 1; i++) {
    const n1 = model.CTX[i], n2 = model.CTX[i + 1];
    const v1 = pp.v[i], v2 = pp.v[i + 1];
    const c1 = pp.c[i], c2 = pp.c[i + 1];
    if (v1 == null || v2 == null) {
      segments.push(null);
      continue;
    }
    const t1 = n1 / v1, t2 = n2 / v2;
    const dTime = t2 - t1;
    segments.push({
      fromCtx: n1,
      toCtx: n2,
      // Marginal tokens/sec for tokens appended within this segment. A
      // non-positive dTime means the curve inverted between checkpoints
      // (measurement noise, not a real speedup appending more context).
      rate: dTime > 0 ? (n2 - n1) / dTime : null,
      est: c1 !== 'm' || c2 !== 'm',
    });
  }
  return segments;
}

const marginalRateAt = (model, arch, platId, atCtx) =>
  marginalSegments(model, arch, platId).find(s => s && atCtx >= s.fromCtx && atCtx < s.toCtx) ?? null;

// Matches computeWC's default 16K prompt / 2K generation, so the cold and
// steady-state charts describe the same-sized turn and are directly
// comparable rather than differing in two variables at once.
export const STEADY_STATE_AT_CTX = 16384;
export const STEADY_STATE_TOKENS = 2048;

/**
 * Steady-state turn: append `newTokens` onto a session already `atCtx`
 * tokens deep (KV cache hot, nothing re-processed), then generate
 * `genTokens`. This is the number an active session actually pays turn to
 * turn -- computeWC above is what a cold event costs, not a typical turn.
 */
export function computeSteadyState(model, arch, atCtx = STEADY_STATE_AT_CTX, newTokens = STEADY_STATE_TOKENS, genTokens = STEADY_STATE_TOKENS) {
  return model.PLAT.map(p => {
    const seg = marginalRateAt(model, arch, p.id, atCtx);
    // The appended tokens are in the cache before the first token is generated,
    // so generation runs at atCtx + newTokens deep, not atCtx.
    const dec = decodeAtDepth(model.TG[arch][p.id], atCtx + newTokens);
    if (!seg?.rate || !dec.v) return { id: p.id, ttft: null, gen: null, total: null, est: true, decode: dec };
    const ttft = newTokens / seg.rate;
    const gen = genTokens / dec.v;
    return { id: p.id, ttft, gen, total: ttft + gen, est: seg.est || dec.est, decode: dec };
  });
}

export const steadyStateById = (model, arch, atCtx, newTokens, genTokens) =>
  Object.fromEntries(
    computeSteadyState(model, arch, atCtx, newTokens, genTokens).map(x => [x.id, x])
  );

/**
 * A build's decode rate for an archetype: inherited from its platform when the
 * build is just that platform in a case, explicit when it is a multi-card rig
 * whose numbers do not match any single-card entry.
 */
export function buildDecode(model, b, arch) {
  if (b.deriveFrom) {
    const src = model.TG[arch]?.[b.deriveFrom];
    if (src && src.v != null && src.c !== NO_DATA) return src;
  }
  const key = arch === 'oss120b' ? 'tg120' : 'tgMoe';
  return { v: b[key], c: b[`${key}c`] };
}

export const archOf = valModel => (valModel === 'tg120' ? 'oss120b' : 'moe');

/** Builds that have a decode number for this archetype, richest value first. */
export function rankedBuilds(model, arch, metric) {
  return model.BUILDS
    .filter(b => buildDecode(model, b, arch).v)
    .map(b => ({ b, m: metric(b, buildDecode(model, b, arch).v) }))
    .sort((x, y) => y.m - x.m);
}
