// DOM rendering for the four tables. Each is a pure function of (model, state).

import { FORMATS } from './data.js';
import {
  modelById,
  WEIGHT_FORMATS,
  decodeCeiling,
  prefillCeiling,
  fit,
  cardsToFit,
  fmtGiB,
  bpwOf,
  KV_BYTES_PER_ELEMENT,
} from './ceiling.js';

const el = id => document.getElementById(id);
export const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DASH = '<span class="dash">—</span>';
const usd = v => (v == null ? null : `$${Math.round(v).toLocaleString()}`);
const n0 = v => (v == null ? null : Math.round(v).toLocaleString());
const sig = v => (v == null ? null : v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** 2236 -> 2.2K, 98000 -> 98K, 131072 -> 128K. */
export const fmtDepth = n => {
  if (n == null) return '?';
  if (n < 1000) return String(n);
  const k = n % 1024 === 0 ? n / 1024 : n / 1000;
  return (k < 10 ? String(Math.round(k * 10) / 10) : String(Math.round(k))) + 'K';
};

const FMT_LABEL = { tf32: 'TF32', bf16: 'BF16', fp16: 'FP16', fp8: 'FP8', fp6: 'FP6', fp4: 'FP4', int8: 'INT8', int4: 'INT4' };
const STATE_WORD = { native: 'supported', absent: 'not supported', unknown: 'not sourced' };

export function formatBadges(u) {
  return FORMATS.map(f => {
    const s = u.support[f];
    const why = s.from === 'unit' ? 'set on this card' : s.from === 'rated' ? 'a rated figure exists' : s.from === 'arch' ? `from ${u.archLabel}` : 'no chip generation recorded';
    return `<span class="fmt ${s.state}" title="${FMT_LABEL[f]}: ${STATE_WORD[s.state]} (${why})">${FMT_LABEL[f]}</span>`;
  }).join('');
}

// --- 1. Hardware ------------------------------------------------------------

/** Does a unit pass the hardware filter? Also says which formats it passed only as "not sourced". */
export function unitMatch(u, s) {
  if (s.vendorsOff.has(u.vendor ?? 'Other')) return { ok: false };
  if (s.bw != null && !(u.memoryBandwidthGBs >= s.bw)) return { ok: false };
  if (s.mem != null && !(u.memoryGB >= s.mem)) return { ok: false };
  if (s.price != null && !(u.street != null && u.street <= s.price)) return { ok: false };
  const unknown = [];
  for (const f of s.fmt) {
    const st = u.formats[f];
    if (st === 'native') continue;
    if (st === 'unknown') {
      unknown.push(f);
      if (s.fmtUnknownOk) continue;
    }
    return { ok: false, unknown, onlyUnknown: st === 'unknown' && unknown.length > 0 };
  }
  return { ok: true, unknown };
}

const HW_COLS = (prec) => [
  { key: 'label', label: 'Unit', cls: 'lbl', sort: u => u.label, cell: u => `<td class="lbl"><span>${esc(u.label)}</span><span class="sub">${esc(u.archLabel ?? 'generation not recorded')}${u.released ? ` · ${u.released}` : ''}</span></td>` },
  { key: 'mem', label: 'Memory GB', sort: u => u.memoryGB, cell: u => `<td class="num">${u.memoryGB ?? DASH}</td>` },
  { key: 'bw', label: 'Bandwidth GB/s', sort: u => u.memoryBandwidthGBs, cell: u => `<td class="num">${n0(u.memoryBandwidthGBs) ?? DASH}</td>` },
  { key: 'fmts', label: 'Matrix formats', cls: 'lbl', cell: u => `<td class="lbl fmts">${formatBadges(u)}</td>` },
  {
    key: 'prec',
    label: `${FMT_LABEL[prec] ?? prec.toUpperCase()} dense`,
    sort: u => u.compute?.values?.[prec],
    cell: u => {
      const d = u.compute?.values?.[prec];
      const sp = u.compute?.values?.[`${prec}:sparse`];
      if (d == null && sp == null) return `<td class="num">${DASH}</td>`;
      return `<td class="num">${d ?? DASH}${sp != null ? `<span class="sub">${sp} sparse</span>` : ''}</td>`;
    },
  },
  { key: 'tdp', label: 'TDP W', sort: u => u.tdpW, cell: u => `<td class="num">${u.tdpW ?? DASH}</td>` },
  {
    key: 'street',
    label: 'Street',
    sort: u => u.street,
    cell: u => `<td class="num">${usd(u.street) ?? DASH}${u.pricing?.street?.asOf ? `<span class="sub">${esc(u.pricing.street.asOf)}</span>` : ''}</td>`,
  },
  { key: 'perGB', label: '$ per GB', sort: u => (u.street && u.memoryGB ? u.street / u.memoryGB : null), cell: u => `<td class="num">${u.street && u.memoryGB ? usd(u.street / u.memoryGB) : DASH}</td>` },
  {
    key: 'bwPerK',
    label: 'GB/s per $1k',
    sort: u => (u.street && u.memoryBandwidthGBs ? u.memoryBandwidthGBs / (u.street / 1000) : null),
    cell: u => `<td class="num">${u.street && u.memoryBandwidthGBs ? n0(u.memoryBandwidthGBs / (u.street / 1000)) : DASH}</td>`,
  },
];

/** Missing values sort last in both directions: an unknown figure is not a zero one. */
function sortRows(rows, col, dir) {
  const k = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * k;
  });
}

export function renderHardwareTable(model, state, matches) {
  const cols = HW_COLS(state.scatterPrec);
  const active = cols.find(c => c.key === state.hwSort.key) ?? cols[2];
  el('hwTable').querySelector('thead tr').innerHTML = cols
    .map(c => {
      const on = c === active;
      const cls = [c.cls, c.sort ? 'sortable' : null, on ? 'sorted' : null].filter(Boolean).join(' ');
      const arrow = on ? (state.hwSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
      return `<th${cls ? ` class="${cls}"` : ''}${c.sort ? ` data-sortkey="${c.key}" title="Sort by ${esc(c.label)}"` : ''}>${esc(c.label)}${arrow}</th>`;
    })
    .join('');
  const rows = sortRows(model.UNITS.filter(u => matches.get(u.id).ok), active, state.hwSort.dir);
  el('hwTable').querySelector('tbody').innerHTML = rows.length
    ? rows.map(u => `<tr>${cols.map(c => c.cell(u)).join('')}</tr>`).join('')
    : `<tr><td class="lbl" colspan="${cols.length}" style="color:var(--muted);padding:16px">No unit passes every filter. Loosen one above.</td></tr>`;
  el('hwNote').textContent =
    `Throughput in 10¹² ops/sec at the precision chosen for the chart; "sparse" is the 2:4 structured-sparsity rate vendors often quote unlabelled. ` +
    `$ per GB and GB/s per $1k use the dated street price. Blanks sort last in both directions. Click a heading to sort.`;
}

// --- 2. Ceilings ------------------------------------------------------------

/** Every ceiling figure for one unit at the calculator's settings. */
export function ceilingRow(m, u, s) {
  const { bpw } = bpwOf(s.weights);
  const kv = { kvK: s.kv, kvV: s.kv };
  const auto = s.cards === 'auto';
  const n = auto ? cardsToFit(m, u, { mode: s.split, bpw, depth: s.depth, ...kv }) : Number(s.cards);
  if (n == null) return { u, n: null };
  const mode = n === 1 ? 'single' : s.split;
  const f = fit(m, u, { cards: n, mode, bpw, depth: s.depth, ...kv });
  const d = decodeCeiling(m, u, { cards: n, mode, bpw, depth: s.depth, ...kv });
  const p = prefillCeiling(m, u, { cards: n, formatKey: s.weights, depth: s.depth });
  const cost = u.street != null ? u.street * n : null;
  return { u, n, mode, fit: f, decode: d?.tps ?? null, prefill: p, cost, perK: d?.tps && cost ? d.tps / (cost / 1000) : null };
}

const barCell = (v, max, extra = '') =>
  v == null
    ? `<td class="lbl">${DASH}</td>`
    : `<td class="lbl"><div class="bar"><span class="v">${sig(v)}</span><span class="track"><span class="fill" style="width:${Math.max(1, (100 * v) / max).toFixed(1)}%"></span></span></div>${extra}</td>`;

export function renderCeilingTable(model, state, units) {
  const m = modelById(state.model);
  const tb = el('ceilTable').querySelector('tbody');
  if (!m?.params?.active) {
    tb.innerHTML = `<tr><td class="lbl" colspan="7">No parameter count recorded for this model.</td></tr>`;
    return;
  }
  const rows = units.filter(u => u.memoryBandwidthGBs).map(u => ceilingRow(m, u, state));
  const fitting = rows.filter(r => r.n != null && r.fit?.fits);
  const tight = rows.filter(r => r.n != null && !r.fit?.fits);
  const none = rows.filter(r => r.n == null);
  const max = Math.max(...rows.map(r => r.decode ?? 0), 1);
  const byDecode = (a, b) => (b.decode ?? -1) - (a.decode ?? -1);

  const row = r => {
    const u = r.u;
    if (r.n == null) {
      return `<tr><td class="lbl">${esc(u.label)}<span class="sub">${esc(u.archLabel ?? '')}</span></td><td class="num">${DASH}</td>` +
        `<td class="lbl t-bad" colspan="5">Does not fit in 8 cards at this depth.</td></tr>`;
    }
    const f = r.fit;
    const mem = f
      ? `<td class="lbl"><span class="${f.fits ? 't-ok' : 't-bad'}">${f.fits ? 'fits' : 'does not fit'}</span><span class="sub">needs ${fmtGiB(f.need)} of ${fmtGiB(f.have)}${f.replicate > 1 ? ` · KV ×${f.replicate} replicated` : ''}</span></td>`
      : `<td class="lbl">${DASH}</td>`;
    const prec = r.prefill.precision;
    const pre = r.prefill.tps == null
      ? `<td class="lbl">${DASH}<span class="sub">no rated ${prec.precision.toUpperCase()} figure</span></td>`
      : `<td class="lbl"><span class="num">${n0(r.prefill.tps)}</span><span class="sub" title="${esc(prec.note)}">${prec.precision.toUpperCase()}${prec.grounded ? '' : ' · assumed'}</span></td>`;
    const modeWord = r.n === 1 ? '' : r.mode === 'tensor' ? 'tensor parallel' : 'layer split';
    return (
      `<tr${f && !f.fits ? ' style="opacity:.55"' : ''}>` +
      `<td class="lbl">${esc(u.label)}<span class="sub">${esc(u.archLabel ?? '')}</span></td>` +
      `<td class="num">${r.n}<span class="sub">${modeWord}</span></td>` +
      mem +
      barCell(r.decode, max) +
      pre +
      `<td class="num">${usd(r.cost) ?? DASH}</td>` +
      `<td class="num">${r.perK != null ? sig(r.perK) : DASH}</td>` +
      '</tr>'
    );
  };
  tb.innerHTML =
    [...fitting.sort(byDecode), ...tight.sort(byDecode), ...none].map(row).join('') ||
    `<tr><td class="lbl" colspan="7" style="color:var(--muted);padding:16px">No unit in scope has a bandwidth figure.</td></tr>`;

  const w = WEIGHT_FORMATS[state.weights];
  el('ceilNote').textContent =
    `Decode: tokens/sec for one stream, one token per pass, at ${fmtDepth(state.depth)} deep. ` +
    `Prefill: tokens/sec appended at that depth, at the precision shown (hover for the kernel finding; "assumed" means no grounded finding, FP16 used). ` +
    `Weights at ${w.label}${w.bpw ? ` ≈ ${w.bpw} bits per weight` : ''}; ${state.cards === 'auto' ? 'cards: the fewest of 1, 2, 4 or 8 that fit' : `${state.cards} card${state.cards === '1' ? '' : 's'} each`}. ` +
    `Price is the cards alone at their dated street price — no host, bridge or board.`;
}

// --- 3. Observations --------------------------------------------------------

const PROV_TITLE = {
  witnessed: 'The maintainer personally saw this hardware produce these numbers.',
  reported: "Someone else's account, included because nothing gives a specific reason to doubt it.",
};
const provChips = p =>
  `<span class="prov" title="${esc(p.source)}">${esc(p.kind)}${p.reproduced === false ? ' · unreproduced' : p.reproduced ? ' · reproduced' : ''}</span>` +
  `<span class="prov ${p.attestation}" title="${esc(PROV_TITLE[p.attestation] + (p.note ? ` ${p.note}` : ''))}">${p.attestation}</span>`;

const rigLabel = (model, rig) => rig.units.map(c => `${c.count}× ${model.unitById[c.unit]?.label ?? c.unit}`).join(' + ');

function lineHead(model, l) {
  const m = modelById(l.model);
  const q = l.quant;
  const { bpw } = bpwOf(q.key, q.bpw);
  const weights = [esc(q.format), bpw ? `${sig(bpw)} bpw${q.bpw ? '' : ' (typical)'}` : '', q.kld ? `KLD ${q.kld.code} code / ${q.kld.prose} prose` : '']
    .filter(Boolean)
    .join(' · ');
  const kv = l.kvCache ? `${esc(l.kvCache.k)}/${esc(l.kvCache.v)}` : 'not recorded';
  const engine = [l.engine.name, l.engine.version, l.engine.lineage, l.engine.note].filter(Boolean).map(esc).join(' · ');
  const split = l.parallel ? `${l.parallel.mode === 'tensor' ? 'tensor parallel' : 'layer split'}` : l.rig.units.reduce((n, u) => n + u.count, 0) > 1 ? 'not recorded' : '';
  const when = l.observed ? `observed ${esc(l.observed)}` : `recorded ${esc(l.recorded)} (no date from the source)`;
  const details = [
    l.modelNote,
    l.rig.note,
    l.note,
    ...(l.hazards ?? []).map(h => `Hazard: ${h}`),
    `Source: ${l.provenance.source}`,
  ].filter(Boolean);
  return (
    `<tr class="line-head"><td colspan="5">` +
    `<div class="title">${esc(l.label)}${l.status === 'withdrawn' ? ' <span class="t-bad">withdrawn</span>' : ''}</div>` +
    `<div class="meta">` +
    `<span><b>${esc(m?.label ?? 'model not recorded')}</b></span>` +
    `<span>on <b>${esc(rigLabel(model, l.rig))}</b>${split ? ` · ${split}` : ''}</span>` +
    `<span>${engine}</span>` +
    `<span>weights ${weights}</span>` +
    `<span>KV ${kv}</span>` +
    (l.spec ? `<span>spec ${esc(l.spec.method)}${l.spec.draftN ? ` n=${l.spec.draftN}` : ''}</span>` : '') +
    `<span>${when}</span>` +
    `<span>${provChips(l.provenance)}</span>` +
    `</div>` +
    `<details><summary>${details.length} note${details.length === 1 ? '' : 's'}</summary><ul>${details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` +
    `</td></tr>`
  );
}

function pointRow(l, r) {
  const what = r.metric === 'decode' ? 'Decode' : `Prefill${r.prefillBasis === 'cold' ? ', cold' : ', new tokens'}`;
  const at = r.depth == null ? 'depth not recorded' : `at ${fmtDepth(r.depth)}`;
  const streams = r.streams > 1 ? ` · ${r.streams} streams, ${r.basis === 'aggregate' ? 'total' : 'each'}` : '';
  const spec = r.spec === 'off' ? ' · spec off' : '';
  const value = r.range ? `${r.range[0]}–${r.range[1]}` : sig(r.value);
  const c = r.ceiling;
  const specOn = c.speculative;
  let share = `<td class="lbl"><span class="sub">${esc(c.why ?? '')}</span></td>`;
  if (r.ratio != null) {
    const pct = r.ratio * 100;
    const cls = specOn ? 'spec' : pct > 105 ? 'over' : '';
    share =
      `<td class="lbl"><div class="bar"><span class="v">${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</span><span class="track"><span class="fill ${cls}" style="width:${Math.min(100, Math.max(1, pct)).toFixed(1)}%"></span></span>${specOn ? '<span class="specmark" title="Speculative decoding was on: more than one token per pass is possible, so this can legitimately exceed the ceiling">spec</span>' : ''}</div>` +
      (r.depth == null && r.metric === 'decode' ? '<span class="sub">vs the empty-context ceiling, so at least this</span>' : '') +
      (r.range ? '<span class="sub">top of the range</span>' : '') +
      '</td>';
  }
  const notes = [
    r.confidence === 'm~' ? 'secondary or anecdotal source' : '',
    r.depthNote ?? '',
    c.assumedKv && r.metric === 'decode' ? 'KV format not recorded: 16-bit assumed' : '',
    r.acceptance != null ? `draft acceptance ${r.acceptance}` : '',
    r.note ?? '',
  ].filter(Boolean);
  return (
    `<tr class="pt">` +
    `<td class="lbl">${what} ${at}${streams}${spec}</td>` +
    `<td class="num">${value}</td>` +
    `<td class="num">${c.tps ? sig(c.tps) : DASH}${c.precision ? `<span class="sub">${c.precision.precision.toUpperCase()}${c.precision.grounded ? '' : ' assumed'}</span>` : ''}</td>` +
    share +
    `<td class="lbl wrap" style="min-width:220px;max-width:380px;font-size:11.5px;color:var(--muted)">${notes.map(esc).join('<br>')}</td>` +
    `</tr>`
  );
}

export function obsMatches(l, r, s) {
  if (s.obsDevice && !l.rig.units.some(u => u.unit === s.obsDevice)) return false;
  if (s.obsModel && (l.model ?? '') !== s.obsModel) return false;
  if (s.obsMetric !== 'all' && r.metric !== s.obsMetric) return false;
  if (s.obsProv !== 'all' && l.provenance.attestation !== s.obsProv) return false;
  return true;
}

export function renderObservations(model, state) {
  const order = (a, b) => (b.observed ?? b.recorded).localeCompare(a.observed ?? a.recorded) || a.label.localeCompare(b.label);
  let lines = 0;
  let points = 0;
  const html = [];
  for (const l of model.LINES.slice().sort(order)) {
    const pts = l.points.filter(r => obsMatches(l, r, state));
    if (!pts.length) continue;
    lines++;
    points += pts.length;
    html.push(lineHead(model, l), ...pts.map(r => pointRow(l, r)));
  }
  el('obsTable').querySelector('tbody').innerHTML =
    html.join('') || `<tr><td class="lbl" colspan="5" style="color:var(--muted);padding:16px">No reading matches these filters.</td></tr>`;
  const all = model.LINES.reduce((n, l) => n + l.points.length, 0);
  const withCeil = model.LINES.reduce((n, l) => n + l.points.filter(p => p.ratio != null).length, 0);
  el('obsSummary').innerHTML = `<b>${points}</b> of ${all} readings in <b>${lines}</b> serving lines. ${withCeil} of the ${all} have a ceiling to compare against; the rest say why not.`;
  el('obsNote').textContent =
    'Newest first, by the source’s own date where it gave one, else the date the reading entered this page. ' +
    'Ceilings use the line’s own recorded bits per weight where it has one, else the typical width of its format.';
}

// --- 4. Rigs under consideration --------------------------------------------

export function renderCandidates(model, state) {
  const tb = el('candTable').querySelector('tbody');
  const { bpw } = bpwOf(state.weights);
  tb.innerHTML = model.CANDIDATES.map(c => {
    const u = model.unitById[c.rig.units[0].unit];
    const n = c.rig.units.reduce((t, x) => t + x.count, 0);
    const ic = c.rig.interconnect;
    const t = c.rigTotals;
    const price = t.costUsd == null ? DASH : usd(t.costUsd) + (t.costHighUsd > t.costUsd ? `–${usd(t.costHighUsd)}` : '');
    const priceSub = t.costUsd == null ? 'unpriced' : t.linkPriced === false ? 'cards only · bridge/board unpriced' : t.linkPriced ? 'cards + bridge/board' : 'cards, street';
    const ceil = c.models
      .map(id => {
        const m = modelById(id);
        if (!m?.params?.active) return `${esc(m?.label ?? id)}: no parameter count recorded`;
        const args = { bpw, depth: state.depth, kvK: state.kv, kvV: state.kv };
        const fl = fit(m, u, { ...args, cards: n, mode: 'tensor' });
        const fll = fit(m, u, { ...args, cards: n, mode: 'layer' });
        const dl = decodeCeiling(m, u, { ...args, cards: n, mode: 'layer' });
        const dt = decodeCeiling(m, u, { ...args, cards: n, mode: 'tensor' });
        const fits = `${fll?.fits ? '<span class="t-ok">fits</span>' : '<span class="t-bad">does not fit</span>'} layer-split${fl && fl.fits !== fll?.fits ? ` · ${fl.fits ? '<span class="t-ok">fits</span>' : '<span class="t-bad">does not fit</span>'} TP` : ''}`;
        return `<b>${esc(m.label)}</b>: ${fits}<br><span class="num">${dl ? sig(dl.tps) : '—'}</span> layer · <span class="num">${dt ? sig(dt.tps) : '—'}</span> TP decode`;
      })
      .join('<br>');
    return (
      '<tr class="cand-main">' +
      `<td class="lbl wrap" style="min-width:200px">${esc(c.label)}<span class="sub">${esc(c.status)}</span></td>` +
      `<td class="num">${t.memoryGB ?? '—'} GB</td>` +
      `<td class="num">${u?.memoryBandwidthGBs ?? '—'}<span class="sub">GB/s per card</span></td>` +
      `<td class="num">${price}<span class="sub">${priceSub}</span></td>` +
      `<td class="lbl wrap" style="min-width:160px;font-size:11.5px">${esc(ic?.kind ?? 'not recorded')}<span class="sub" title="${esc(ic?.note ?? '')}">${esc(ic?.bridge ?? '')}</span></td>` +
      `<td class="lbl">${ic?.peakP2pGBsPerGpu != null ? `<span class="num">${ic.peakP2pGBsPerGpu} GB/s</span>` : '<span class="dash" title="The vendor states no GB/s figure">not stated</span>'}<span class="sub">peak P2P per GPU${ic?.linksPerGpu ? ` · ${ic.linksPerGpu} links` : ''}</span><span class="sub">${ic?.hostLinkGBs ? `host link ${ic.hostLinkGBs} GB/s` : 'host link unverified'}</span></td>` +
      `<td class="lbl wrap" style="font-size:11.5px;color:var(--muted)">${ceil}<span class="sub">at ${fmtDepth(state.depth)} deep, ${esc(WEIGHT_FORMATS[state.weights].label)}, KV ${esc(state.kv)}</span></td>` +
      '</tr>' +
      `<tr class="cand-notes"><td colspan="7">${esc(c.note ?? '')}${c.rig.host?.note ? `<br><b style="color:var(--text)">Host:</b> ${esc(c.rig.host.note)}` : ''}${ic?.note ? `<br><b style="color:var(--text)">Interconnect:</b> ${esc(ic.note)}` : ''}</td></tr>`
    );
  }).join('');
}

export { KV_BYTES_PER_ELEMENT };
