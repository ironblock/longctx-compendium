// Loads data/compendium.json and normalizes the authored, device-major shape
// into the flat lookup tables the render code wants.
//
// The authored file optimizes for editing (one object per device, everything
// optional, keys instead of array positions). The runtime shape optimizes for
// charting (dense arrays aligned to a context axis). Everything in between
// happens here, so adding a field to the data file never means touching
// chart code, and a half-filled device degrades to em dashes instead of
// throwing.

const DATA_URL = new URL('../data/compendium.json', import.meta.url);

/** Confidence code meaning "we have nothing here". Never authored; only synthesized. */
const NO_DATA = 'n';

/**
 * A measurement is authored as [value, confidence] or, when it needs
 * provenance, {value, confidence, source, note}. Both normalize to the same
 * pair so every consumer can treat them identically.
 */
export function measurement(raw) {
  if (raw == null) return { v: null, c: NO_DATA };
  if (Array.isArray(raw)) return { v: raw[0] ?? null, c: raw[1] ?? NO_DATA };
  if (typeof raw === 'object') {
    return {
      v: raw.value ?? null,
      c: raw.confidence ?? NO_DATA,
      source: raw.source,
      note: raw.note,
    };
  }
  // Bare scalar: a specification, not a benchmark. Modeled-from-specs is the
  // honest confidence for anything not actually run.
  return { v: raw, c: 'i' };
}

function normalizePlatformPerf(platform, arch, contexts) {
  const entry = platform.perf?.[arch];
  const prefill = entry?.prefill ?? {};

  // Absent context keys become nulls at the right index, so the value and
  // confidence arrays cannot drift out of alignment the way hand-maintained
  // parallel arrays could.
  const v = [];
  const c = [];
  for (const { tokens } of contexts) {
    const m = measurement(prefill[String(tokens)]);
    v.push(m.v);
    c.push(m.c);
  }

  const short = measurement(entry?.decode?.short);
  const at32k = measurement(entry?.decode?.at32k);

  return {
    pp: { v, c, note: entry?.note ?? '' },
    tg: {
      v: short.v,
      c: short.c,
      v32: at32k.v,
      note: entry?.decodeNote ?? entry?.note ?? '',
    },
  };
}

export function normalize(doc) {
  const contexts = doc.meta.contexts;
  const archIds = doc.meta.archetypes.map(a => a.id);

  const CTX = contexts.map(c => c.tokens);
  const CTXL = contexts.map(c => c.label);

  const PLAT = doc.platforms.map(p => ({ id: p.id, ...p.display }));

  const PP = {};
  const TG = {};
  for (const arch of archIds) {
    PP[arch] = {};
    TG[arch] = {};
    for (const p of doc.platforms) {
      const { pp, tg } = normalizePlatformPerf(p, arch, contexts);
      PP[arch][p.id] = pp;
      TG[arch][p.id] = tg;
    }
  }

  // A build is a purchasable box. Most map 1:1 onto a platform and inherit its
  // decode numbers via deriveFrom; the multi-card rigs that have no single
  // platform equivalent carry their own.
  const derived = doc.platforms
    .filter(p => p.system)
    .map(p => ({
      id: `b_${p.id}`,
      // A rig can be named differently from the bare card it is built around
      // ("4× V100" the build vs "V100×4" the platform series).
      label: p.system.buildLabel ?? p.display.label,
      short: p.system.buildShort ?? p.display.short,
      color: p.display.color,
      cost: p.system.buildCostUsd,
      loadW: p.system.loadW,
      idleW: p.system.idleW,
      deriveFrom: p.id,
    }));

  const explicit = (doc.builds ?? []).map(b => {
    const rec = {
      id: b.id,
      label: b.display.label,
      short: b.display.short,
      color: b.display.color,
      cost: b.system.buildCostUsd,
      loadW: b.system.loadW,
      idleW: b.system.idleW,
    };
    for (const [arch, key] of [['oss120b', 'tg120'], ['moe', 'tgMoe']]) {
      const m = measurement(b.decode?.[arch]);
      rec[key] = m.v;
      rec[`${key}c`] = m.c;
    }
    return rec;
  });

  return {
    CTX,
    CTXL,
    PLAT,
    PP,
    TG,
    BUILDS: [...explicit, ...derived],
    ARCHETYPES: doc.meta.archetypes,
    ARCH_DESC: Object.fromEntries(doc.meta.archetypes.map(a => [a.id, a.desc])),
    KWH: doc.meta.electricityUsdPerKwh,
    CONFIDENCE: doc.meta.confidence,
    raw: doc,
  };
}

/**
 * Structural checks that a JSON Schema cannot express, run at page load so a
 * bad edit surfaces as a readable message rather than a blank page.
 */
export function audit(model) {
  const problems = [];
  const seen = new Set();
  for (const p of model.PLAT) {
    if (seen.has(p.id)) problems.push(`duplicate platform id "${p.id}"`);
    seen.add(p.id);
    if (!p.short || !p.color) problems.push(`platform "${p.id}" is missing display.short or display.color`);
  }
  for (const b of model.BUILDS) {
    if (b.deriveFrom && !seen.has(b.deriveFrom)) {
      problems.push(`build "${b.id}" derives from unknown platform "${b.deriveFrom}"`);
    }
    if (!(b.cost > 0)) problems.push(`build "${b.id}" has no positive buildCostUsd`);
    if (!(b.loadW > 0)) problems.push(`build "${b.id}" has no positive loadW`);
  }
  const codes = new Set([...Object.keys(model.CONFIDENCE), NO_DATA]);
  for (const arch of Object.keys(model.PP)) {
    for (const [id, d] of Object.entries(model.PP[arch])) {
      for (const code of d.c) {
        if (!codes.has(code)) problems.push(`unknown confidence code "${code}" in ${arch}/${id} prefill`);
      }
    }
  }
  return problems;
}

export async function load() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`could not fetch ${DATA_URL.pathname} (HTTP ${res.status})`);
  const model = normalize(await res.json());
  const problems = audit(model);
  if (problems.length) throw new Error(`data problems:\n- ${problems.join('\n- ')}`);
  return model;
}
