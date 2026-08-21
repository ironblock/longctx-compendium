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
      // Kept so a depth-adjusted decode rate can report honest confidence
      // rather than inheriting the short-context code.
      c32: at32k.c,
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

  // Cost, power and capacity are summed from the hardware catalog rather than
  // stored, so correcting one card's street price corrects every platform and
  // every rig that contains it.
  const unitById = Object.fromEntries((doc.units ?? []).map(u => [u.id, u]));
  const platformById = Object.fromEntries(doc.platforms.map(p => [p.id, p]));
  const TOTALLED = ['costUsd', 'loadW', 'idleW', 'memoryGB'];

  /**
   * Adds contributions, but only where every contributor knows its value. One
   * unpriced card makes the whole total unknown rather than making the rig look
   * free -- a silent zero here would read as "infinitely efficient".
   */
  function sum(parts) {
    const out = {};
    for (const key of TOTALLED) {
      out[key] = parts.some(p => p[key] == null)
        ? null
        : parts.reduce((n, p) => n + p[key], 0);
    }
    return out;
  }

  const scale = (t, n) =>
    Object.fromEntries(TOTALLED.map(k => [k, t[k] == null ? null : t[k] * n]));

  function unitTotals(id, count, at) {
    const u = unitById[id];
    if (!u) throw new Error(`${at} references unknown unit "${id}"`);
    return scale(
      {
        costUsd: u.pricing?.street?.usd ?? null,
        loadW: u.power?.loadW ?? null,
        idleW: u.power?.idleW ?? null,
        memoryGB: u.memoryGB ?? null,
      },
      count
    );
  }

  const platformTotals = p =>
    sum((p.composition ?? []).map(c => unitTotals(c.unit, c.count ?? 1, `platform "${p.id}"`)));

  // Cached because builds resolve through platforms and several share one.
  const platformSpec = Object.fromEntries(doc.platforms.map(p => [p.id, platformTotals(p)]));

  const BUILDS = (doc.builds ?? []).map(b => {
    const parts = (b.units ?? []).map(u => {
      const count = u.count ?? 1;
      if (!u.platform) return unitTotals(u.unit, count, `build "${b.id}"`);
      if (!platformById[u.platform]) {
        throw new Error(`build "${b.id}" references unknown platform "${u.platform}"`);
      }
      return scale(platformSpec[u.platform], count);
    });
    // Anything the units do not account for -- chassis, CPU, PSU, cooling --
    // goes in host, so the residual stays visible.
    if (b.host) {
      parts.push({
        costUsd: b.host.costUsd ?? 0,
        loadW: b.host.loadW ?? 0,
        idleW: b.host.idleW ?? 0,
        memoryGB: 0,
      });
    }
    const totals = sum(parts);

    const rec = {
      id: b.id,
      label: b.display.label,
      short: b.display.short,
      color: b.display.color,
      cost: totals.costUsd,
      loadW: totals.loadW,
      idleW: totals.idleW,
      memoryGB: totals.memoryGB,
    };

    // One unit of one platform performs exactly like that platform, so its
    // decode rate is inherited. Anything else -- more units, or a rig that
    // scales differently -- states its own.
    const solo = b.units?.length === 1 && b.units[0].platform && (b.units[0].count ?? 1) === 1;
    if (!b.decode && solo) {
      rec.deriveFrom = b.units[0].platform;
    } else {
      for (const [arch, key] of [['oss120b', 'tg120'], ['moe', 'tgMoe']]) {
        const m = measurement(b.decode?.[arch]);
        rec[key] = m.v;
        rec[`${key}c`] = m.c;
      }
    }
    return rec;
  });

  return {
    CTX,
    CTXL,
    PLAT,
    PP,
    TG,
    BUILDS,
    UNITS: doc.units ?? [],
    // Capacity, price and draw for each benchmarked configuration, summed from
    // the units it is made of.
    PLATFORM_SPEC: platformSpec,
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
