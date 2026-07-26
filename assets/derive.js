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
