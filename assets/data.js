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

/**
 * A carrier's host link per GPU: line rate x lanes, both directions, divided
 * among the GPUs that share an uplink when all of them stream. Encoding
 * overhead is not subtracted, matching hostLinkGBs elsewhere.
 */
export const carrierHostGBs = k => (k?.hostLink ? ((PCIE[k.hostLink.gen].gts / 8) * k.hostLink.lanes * 2) / k.hostLink.gpusPerUplink : null);

/**
 * A host's theoretical memory bandwidth in GB/s: channels x MT/s x 8 bytes,
 * times its sockets (a system's host records them; a reference platform is one). What CPU code actually reads is lower (a measured figure
 * sits beside it where one was found), which keeps a ceiling built on it an
 * upper bound. null when the memory is not recorded.
 */
export const hostBandwidthGBs = h => (h?.memory?.channels && h.memory.mts ? (h.memory.channels * h.memory.mts * 8 * (h.memory.sockets ?? 1)) / 1000 : null);

/**
 * The open-weight frontier on the current version of the quality index. Each
 * model takes its best score among its variants (effort levels, reasoning
 * modes) on that version; it is on the frontier when no model of its size or
 * smaller scores higher. Release dates say when it joined and when it left:
 * a model beaten by something released earlier was never on it.
 */
export function frontierOf(openModels, qi) {
  const pts = (openModels ?? [])
    .map(m => {
      const cur = (m.scores ?? []).filter(s => s.index === qi?.id && s.version === qi?.version);
      const best = cur.reduce((b, s) => (b == null || s.value > b.value ? s : b), null);
      // What has to sit in GPU memory: the published total less lookup tables
      // (host RAM) and any MTP head the total includes (resident only with MTP on).
      const lookup = m.params.lookup ?? 0;
      const mtp = m.params.mtp ?? null;
      const gpu = m.params.total - lookup - (m.params.mtpInTotal && mtp ? mtp : 0);
      return { ...m, best, total: m.params.total, active: m.params.active ?? null, gpu, lookup, lookupBits: m.params.lookupBits ?? null, mtp, routed: m.params.routed ?? null, nonRouted: m.params.nonRouted ?? null };
    })
    .filter(p => p.best);
  for (const p of pts) {
    const better = pts.filter(q => q !== p && q.total <= p.total && q.best.value > p.best.value);
    const bySize = (a, b) => a.total - b.total;
    const earlier = better.filter(q => q.released <= p.released).sort(bySize);
    const later = better.filter(q => q.released > p.released).sort((a, b) => (a.released < b.released ? -1 : 1));
    p.onFrontier = better.length === 0;
    p.neverOn = earlier.length > 0;
    // Never on it: the smallest model already out that beats it. Left it: the first model to.
    p.knockedOffBy = p.neverOn ? earlier[0] : later[0] ?? null;
    p.leftOn = !p.onFrontier && !p.neverOn ? later[0]?.released ?? null : null;
    p.beatenBy = better.sort(bySize)[0] ?? null;
  }
  return pts.sort((a, b) => a.total - b.total);
}

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
      // GPUs per board: memory, bandwidth and compute are per GPU, the price per board.
      gpus: u.board?.gpus ?? 1,
      // Largest group joined without PCIe; null when not yet sourced.
      link: u.peerLink ? u.peerLink.maxCards : null,
      // Every group size it can run in, unlinked (0) included; null when not yet sourced.
      linkSizes: u.peerLink ? [0, ...(u.peerLink.options ?? []), u.peerLink.maxCards] : null,
      // PCIe host link, per direction; null for an integrated GPU or an unsourced one.
      hostGBs: u.hostLink ? PCIE[u.hostLink.gen].laneGBs * u.hostLink.lanes : null,
      form: formKind(u.formFactor?.name),
    };
  });
  const unitById = Object.fromEntries(UNITS.map(u => [u.id, u]));
  // A system's host memory bandwidth, where its memory is recorded: what its CPUs compute experts at.
  const CARRIERS = (doc.carriers ?? []).map(k => (k.host?.memory ? { ...k, host: { ...k.host, bandwidthGBs: hostBandwidthGBs(k.host) } } : k));
  const carrierById = Object.fromEntries(CARRIERS.map(k => [k.id, k]));

  /**
   * The interconnect a rig actually has. On a carrier the board supplies the
   * bridge, link figures, host link and price, and each module's fit decides
   * whether NVLink is in use; without one, the rig's own record stands.
   */
  const linkOf = rig => {
    const k = rig.carrier ? carrierById[rig.carrier] : null;
    if (!k) return rig.interconnect ?? null;
    const fits = rig.units.map(c => ({ unit: c.unit, ...(k.fits.find(f => f.unit === c.unit) ?? { status: 'untested', peer: 'pcie' }) }));
    // The board's own peer fabric is in use only if every module on it wires it too.
    const fabric = ['nvlink', 'ethernet'].includes(k.peer?.kind) && fits.every(f => f.peer === k.peer.kind) ? k.peer.kind : null;
    const n = rig.units.reduce((t, c) => t + c.count, 0);
    const g = k.hostLink?.gpusPerUplink;
    let pciePath = null;
    if (!fabric && n > 1) {
      if (k.switch == null) pciePath = 'PCIe peer path not recorded';
      else if (!k.switch.present) pciePath = 'PCIe peers meet through the host';
      else if (g && g < n) pciePath = `PCIe peers meet inside a switch in groups of ${g}, through the host between groups`;
      else pciePath = 'PCIe peers meet inside a switch';
    }
    return {
      kind: fabric ?? 'pcie',
      bridge: k.label,
      carrier: k,
      fits,
      linksPerGpu: fabric ? k.peer.linksPerGpu : undefined,
      peakP2pGBsPerGpu: fabric ? k.peer.peakP2pGBsPerGpu : undefined,
      hostLinkGBs: carrierHostGBs(k),
      costUsd: k.pricing ? k.pricing.usd + (k.parts?.usd ?? 0) : undefined,
      costHighUsd: k.pricing ? (k.pricing.highUsd ?? k.pricing.usd) + (k.parts?.highUsd ?? k.parts?.usd ?? 0) : undefined,
      pciePath,
      source: fabric ? k.peer?.source : undefined,
      note: rig.interconnect?.note,
      p2p: rig.interconnect?.p2p,
    };
  };

  /**
   * Cost, capacity and draw summed from the catalog. One unpriced card makes
   * the total unknown rather than making the rig look free.
   */
  const rigTotals = rig => {
    const parts = rig.units.map(c => ({ u: unitById[c.unit], n: c.count }));
    const sum = get => (parts.some(p => get(p.u) == null) ? null : parts.reduce((t, p) => t + get(p.u) * p.n, 0));
    // Modules a system's price already includes are not bought again.
    const bundled = rig.carrier ? (carrierById[rig.carrier]?.pricing?.modules ?? []) : [];
    const toBuy = parts.map(p => ({ ...p, n: Math.max(0, p.n - bundled.filter(m => m.unit === p.u?.id).reduce((t, m) => t + m.count, 0)) }));
    // A board of several GPUs (the A16) is bought whole: four of its GPUs cost one board.
    const cards = toBuy.some(p => p.n > 0 && p.u?.street == null) ? null : toBuy.reduce((t, p) => t + (p.n ? p.u.street * Math.ceil(p.n / p.u.gpus) : 0), 0);
    const link = linkOf(rig);
    return {
      memoryGB: sum(u => u?.memoryGB),
      cards: parts.reduce((t, p) => t + p.n, 0),
      costUsd: cards == null ? null : cards + (link?.costUsd ?? 0),
      costHighUsd: cards == null ? null : cards + (link?.costHighUsd ?? link?.costUsd ?? 0),
      linkPriced: link ? link.costUsd != null : null,
      bundled: bundled.length > 0,
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

  const CANDIDATES = (doc.candidates ?? []).map(c => ({ ...c, link: linkOf(c.rig), rigTotals: rigTotals(c.rig) }));
  const QI = doc.meta?.qualityIndex ?? null;
  const FRONTIER = frontierOf(doc.openModels, QI);

  return {
    UNITS,
    unitById,
    ARCHS: doc.architectures ?? [],
    archById,
    LINES,
    CANDIDATES,
    CARRIERS,
    carrierById,
    QI,
    FRONTIER,
    // Reference drives for lookup tables read from an SSD.
    DRIVES: doc.drives ?? [],
    HOSTS: (doc.hosts ?? []).map(h => ({ ...h, bandwidthGBs: hostBandwidthGBs(h) })),
    hostById: Object.fromEntries((doc.hosts ?? []).map(h => [h.id, { ...h, bandwidthGBs: hostBandwidthGBs(h) }])),
    driveById: Object.fromEntries((doc.drives ?? []).map(d => [d.id, d])),
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
  for (const l of [...model.LINES, ...model.CANDIDATES]) {
    if (l.rig.carrier && !model.carrierById[l.rig.carrier]) problems.push(`"${l.id}" names unknown carrier "${l.rig.carrier}"`);
  }
  for (const k of model.CARRIERS) {
    for (const f of k.fits ?? []) if (!model.unitById[f.unit]) problems.push(`carrier "${k.id}" lists unknown unit "${f.unit}"`);
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
