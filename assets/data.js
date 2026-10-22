// Loads data/compendium.json and resolves what the page derives from it:
// each unit's matrix-format support (from its chip generation), each rig's
// totals (from its units), and each observation's ceiling (from the unit and
// the model's shape). Nothing derived is stored in the data file, so nothing
// on the page can disagree with it.

import { ceilingFor, ratioOf } from './ceiling.js';

const DATA_URL = new URL('../data/compendium.json', import.meta.url);

/** The matrix formats the page tracks, widest first, as datasheets list them. */
export const FORMATS = ['tf32', 'bf16', 'fp16', 'fp8', 'fp6', 'fp4', 'int8', 'int4'];

/**
 * A unit's support for one format: its own override if it has one (with a
 * note saying why), else a rated figure (which proves the matrix path
 * exists), else its generation's answer, else unknown.
 */
export function formatSupport(unit, arch, f) {
  if (unit.formatOverrides?.[f]) return { state: unit.formatOverrides[f], from: 'unit' };
  const v = unit.compute?.values ?? {};
  if (v[f] != null || v[`${f}:sparse`] != null) return { state: 'native', from: 'rated' };
  const a = arch?.formats?.[f];
  if (a) return { state: a, from: 'arch' };
  return { state: 'unknown', from: 'none' };
}

/**
 * PCIe transfer rate (GT/s) and usable throughput per lane per direction
 * (GB/s): 8b/10b encoding for generations 1-2, 128b/130b for 3-5, and FLIT
 * mode (242 useful bytes in 256) for 6.
 */
export const PCIE = {
  1: { gts: 2.5, laneGBs: 0.25 },
  2: { gts: 5, laneGBs: 0.5 },
  3: { gts: 8, laneGBs: (8 * 128) / 130 / 8 },
  4: { gts: 16, laneGBs: (16 * 128) / 130 / 8 },
  5: { gts: 32, laneGBs: (32 * 128) / 130 / 8 },
  6: { gts: 64, laneGBs: (64 * 242) / 256 / 8 },
};

/** The form-factor filter's groups: every SXM generation is one. */
export const formKind = name => (name == null ? null : name.startsWith('SXM') ? 'SXM' : name);

export function normalize(doc) {
  const archById = Object.fromEntries((doc.architectures ?? []).map(a => [a.id, a]));

  const UNITS = (doc.units ?? []).map(u => {
    const arch = archById[u.arch] ?? null;
    const support = Object.fromEntries(FORMATS.map(f => [f, formatSupport(u, arch, f)]));
    return {
      ...u,
      archLabel: arch ? `${arch.label}` : null,
      archRec: arch,
      support,
      formats: Object.fromEntries(FORMATS.map(f => [f, support[f].state])),
      street: u.pricing?.street?.usd ?? null,
      // Largest group joined without PCIe; null when not yet sourced.
      link: u.peerLink ? u.peerLink.maxCards : null,
      // PCIe host link, per direction; null for an integrated GPU or an unsourced one.
      hostGBs: u.hostLink ? PCIE[u.hostLink.gen].laneGBs * u.hostLink.lanes : null,
      form: formKind(u.formFactor?.name),
    };
  });
  const unitById = Object.fromEntries(UNITS.map(u => [u.id, u]));

  /**
   * Cost, capacity and draw summed from the catalog. One unpriced card makes
   * the total unknown rather than making the rig look free.
   */
  const rigTotals = rig => {
    const parts = rig.units.map(c => ({ u: unitById[c.unit], n: c.count }));
    const sum = get => (parts.some(p => get(p.u) == null) ? null : parts.reduce((t, p) => t + get(p.u) * p.n, 0));
    const cards = sum(u => u?.pricing?.street?.usd);
    const link = rig.interconnect;
    return {
      memoryGB: sum(u => u?.memoryGB),
      cards: parts.reduce((t, p) => t + p.n, 0),
      costUsd: cards == null ? null : cards + (link?.costUsd ?? 0),
      costHighUsd: cards == null ? null : cards + (link?.costHighUsd ?? link?.costUsd ?? 0),
      linkPriced: link ? link.costUsd != null : null,
    };
  };

  const LINES = (doc.lines ?? []).map(l => ({
    ...l,
    rigTotals: rigTotals(l.rig),
    points: (l.results ?? []).map(r => {
      const c = ceilingFor(l, r, unitById);
      const value = r.value ?? (r.range ? r.range[1] : null);
      return { ...r, ceiling: c, ratio: c.tps ? ratioOf(value, c.tps) : null };
    }),
  }));

  const CANDIDATES = (doc.candidates ?? []).map(c => ({ ...c, rigTotals: rigTotals(c.rig) }));

  return {
    UNITS,
    unitById,
    ARCHS: doc.architectures ?? [],
    archById,
    LINES,
    CANDIDATES,
    KWH: doc.meta?.electricityUsdPerKwh,
    raw: doc,
  };
}

/**
 * Structural checks a JSON Schema cannot express, run at page load so a bad
 * edit surfaces as a readable message rather than a blank page. The full set
 * lives in tools/validate.mjs; these are the ones that would break rendering.
 */
export function audit(model) {
  const problems = [];
  const seen = new Set();
  for (const u of model.UNITS) {
    if (seen.has(u.id)) problems.push(`duplicate unit id "${u.id}"`);
    seen.add(u.id);
    if (u.arch && !model.archById[u.arch]) problems.push(`unit "${u.id}" names unknown architecture "${u.arch}"`);
  }
  for (const l of [...model.LINES, ...model.CANDIDATES]) {
    for (const c of l.rig.units) {
      if (!model.unitById[c.unit]) problems.push(`"${l.id}" references unknown unit "${c.unit}"`);
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
