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

/**
 * Wall-clock for one representative agentic turn: a 16K-token prompt prefilled
 * cold, then 2K tokens generated. Flagged estimated unless BOTH the 16K prefill
 * point and the decode rate are primary measurements.
 */
export function computeWC(model, arch, promptTokens = 16384, genTokens = 2048) {
  const idx = model.CTX.indexOf(promptTokens);
  return model.PLAT.map(p => {
    const pp = model.PP[arch][p.id];
    const tg = model.TG[arch][p.id];
    const ppV = idx >= 0 ? pp.v[idx] : null;
    const ppC = idx >= 0 ? pp.c[idx] : NO_DATA;
    if (!ppV || !tg.v) return { id: p.id, ttft: null, gen: null, total: null, est: true };
    const ttft = promptTokens / ppV;
    const gen = genTokens / tg.v;
    return { id: p.id, ttft, gen, total: ttft + gen, est: ppC !== 'm' || tg.c !== 'm' };
  });
}

export const wcById = (model, arch) =>
  Object.fromEntries(computeWC(model, arch).map(x => [x.id, x]));

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
