// Entry point: loads the data, owns the view state (mirrored into the page
// address so any view can be shared as a link), and wires the controls.
// Everything it renders is a pure function of (model, state).

import { load, FORMATS } from './data.js';
import { MODELS } from './models.js';
import {
  WEIGHT_FORMATS,
  WEIGHT_CHOICES,
  KV_CHOICES,
  CARD_STEPS,
  attentionLayout,
  LAYOUT_LABEL,
  decodeBytesPerStep,
  kvBytesAt,
  kvBytesPerToken,
  recurrentStateBytes,
  bpwOf,
  fmtGiB,
} from './ceiling.js';
import { renderScatter, renderDepth, LAYOUT_COLOR, vendorColor } from './charts.js';
import { rangeSlider, slider } from './sliders.js';
import {
  unitMatch,
  renderHardwareTable,
  renderCeilingTable,
  renderObservations,
  renderCandidates,
  fmtDepth,
  esc,
} from './tables.js';

const el = id => document.getElementById(id);

const FMT_LABEL = { tf32: 'TF32', bf16: 'BF16', fp16: 'FP16', fp8: 'FP8', fp6: 'FP6', fp4: 'FP4', int8: 'INT8', int4: 'INT4' };
const SCATTER_PRECS = ['fp16', 'bf16', 'fp8', 'int8', 'fp4'];
const SORT_KEYS = ['label', 'mem', 'bw', 'prec', 'link', 'tdp', 'street', 'perGB', 'bwPerK'];
/** Minimum direct-link group sizes the filter offers. */
const LINK_STEPS = [2, 4, 8];
/** The "Not recorded" choice in the observation model filter. */
export const NO_MODEL = '__none';

/** A section link (#ceilings) is an anchor, not a view; only key=value fragments carry state. */
const isStateHash = h => h.includes('=');
/** The chart precision a view gets when the address does not name one. */
const inferredPrec = fmt => [...fmt].find(f => SCATTER_PRECS.includes(f)) ?? 'fp16';

const DEFAULTS = {
  fmt: [],
  fmtUnknownOk: false,
  bwMin: null,
  bwMax: null,
  memMin: null,
  memMax: null,
  priceMin: null,
  priceMax: null,
  linkMin: null,
  vendorsOff: [],
  scatterPrec: 'fp16',
  hwSort: 'bw:desc',
  model: 'qwen38_27b',
  weights: 'q4_k_m',
  kv: 'f16',
  depth: 131072,
  cards: 'auto',
  // Context depth runs from 1K to 256K tokens, on a log scale, in 1K steps.
  depthMin: 1024,
  depthMax: 262144,
  split: 'tensor',
  scope: 'filtered',
  obsDevice: '',
  obsModel: '',
  obsMetric: 'all',
  obsProv: 'all',
};

// --- state <-> address --------------------------------------------------------

function readState() {
  const raw = location.hash.slice(1);
  const q = new URLSearchParams(isStateHash(raw) ? raw : '');
  const num = k => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : DEFAULTS[k]);
  const str = (k, allowed) => (q.has(k) && (!allowed || allowed.includes(q.get(k))) ? q.get(k) : DEFAULTS[k]);
  const list = k => (q.get(k) ? q.get(k).split(',').filter(Boolean) : DEFAULTS[k]);
  const [sk, sd] = str('sort').split(':');
  // A range typed backwards in an address is read the right way round.
  const span = (a, b) => (a != null && b != null && a > b ? [b, a] : [a, b]);
  const [bwMin, bwMax] = span(num('bw'), num('bwmax'));
  const [memMin, memMax] = span(num('mem'), num('memmax'));
  const [priceMin, priceMax] = span(num('pricemin'), num('price'));
  const d = q.has('d') && q.get('d') !== '' && Number.isFinite(Number(q.get('d'))) ? Number(q.get('d')) : DEFAULTS.depth;
  return {
    fmt: new Set(list('fmt').filter(f => FORMATS.includes(f))),
    fmtUnknownOk: q.get('unk') === '1',
    // Filters are [min, max] with null for an open end. "bw" and "price" keep
    // the meanings they had as single thresholds, so older links still work.
    bwMin,
    bwMax,
    memMin,
    memMax,
    priceMin,
    priceMax,
    linkMin: LINK_STEPS.includes(num('link')) ? num('link') : null,
    vendorsOff: new Set(list('voff')),
    // With no chart precision in the address, the chart follows the first format asked for.
    scatterPrec: q.has('prec') ? str('prec', SCATTER_PRECS) : inferredPrec(list('fmt')),
    hwSort: SORT_KEYS.includes(sk) ? { key: sk, dir: sd === 'asc' ? 'asc' : 'desc' } : { key: 'bw', dir: 'desc' },
    model: str('model', Object.keys(MODELS)),
    weights: str('w', WEIGHT_CHOICES),
    kv: str('kv', KV_CHOICES.map(k => k.id)),
    depth: Math.min(DEFAULTS.depthMax, Math.max(DEFAULTS.depthMin, Math.round(d / 1024) * 1024)),
    cards: str('n', ['auto', '1', '2', '3', '4', '5', '6', '7', '8']),
    split: str('split', ['tensor', 'layer']),
    scope: str('scope', ['filtered', 'all']),
    obsDevice: str('od'),
    obsModel: str('om'),
    obsMetric: str('omet', ['all', 'decode', 'prefill']),
    obsProv: str('oprov', ['all', 'witnessed', 'reported']),
  };
}
// The keys DEFAULTS uses under their address names.
Object.assign(DEFAULTS, { link: null, bw: null, bwmax: null, mem: null, memmax: null, pricemin: null, price: null, sort: DEFAULTS.hwSort, voff: DEFAULTS.vendorsOff, prec: DEFAULTS.scatterPrec, w: DEFAULTS.weights, d: DEFAULTS.depth, n: DEFAULTS.cards, od: '', om: '', omet: 'all', oprov: 'all' });

function writeState(s) {
  const q = new URLSearchParams();
  const put = (k, v, def) => {
    if (v != null && v !== '' && String(v) !== String(def)) q.set(k, v);
  };
  put('fmt', [...s.fmt].join(','), '');
  if (s.fmtUnknownOk) q.set('unk', '1');
  put('bw', s.bwMin, null);
  put('bwmax', s.bwMax, null);
  put('mem', s.memMin, null);
  put('memmax', s.memMax, null);
  put('pricemin', s.priceMin, null);
  put('price', s.priceMax, null);
  put('link', s.linkMin, null);
  put('voff', [...s.vendorsOff].join(','), '');
  put('prec', s.scatterPrec, inferredPrec(s.fmt));
  put('sort', `${s.hwSort.key}:${s.hwSort.dir}`, DEFAULTS.hwSort);
  put('model', s.model, DEFAULTS.model);
  put('w', s.weights, DEFAULTS.weights);
  put('kv', s.kv, DEFAULTS.kv);
  put('d', s.depth, DEFAULTS.depth);
  put('n', s.cards, DEFAULTS.cards);
  put('split', s.split, DEFAULTS.split);
  put('scope', s.scope, DEFAULTS.scope);
  put('od', s.obsDevice, '');
  put('om', s.obsModel, '');
  put('omet', s.obsMetric, 'all');
  put('oprov', s.obsProv, 'all');
  const hash = q.toString();
  // A default view leaves a section anchor alone.
  if (!hash && location.hash && !isStateHash(location.hash.slice(1))) return;
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// --- controls -------------------------------------------------------------------

/** A row of chip buttons. `isOn(v)` decides the pressed state; `onPick(v)` handles a press. */
function chips(id, items, isOn, onPick, cls = () => '') {
  const host = el(id);
  // Rebuilding the row would drop keyboard focus to the page; put it back.
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.i : null;
  host.innerHTML = items
    .map((it, i) => `<button type="button" data-i="${i}" class="${isOn(it.v) ? 'on' : ''} ${cls(it.v)}" aria-pressed="${isOn(it.v)}"${it.title ? ` title="${esc(it.title)}"` : ''}>${it.dot ? `<span class="vdot" style="--c:${esc(it.dot)}" aria-hidden="true"></span>` : ''}${esc(it.label)}</button>`)
    .join('');
  if (focused != null) host.querySelector(`[data-i="${focused}"]`)?.focus();
  host.onclick = e => {
    const b = e.target.closest('button');
    if (b) onPick(items[Number(b.dataset.i)].v);
  };
}

function fail(err) {
  console.error(err);
  const box = el('loadError');
  box.textContent = `Could not render the compendium — ${err.message}`;
  box.classList.remove('hidden');
  document.querySelectorAll('.chartbox, .tscroll').forEach(n => n.classList.add('hidden'));
}

const usd = v => `$${Math.round(v).toLocaleString()}`;
const gbs = v => `${(Math.round(v * 10) / 10).toLocaleString()} GB/s`;
/** "≥ a", "≤ b" or "a–b" for a filter's [min, max]. */
const spanText = ([a, b], f) => (a != null && b != null ? `${f(a)}–${f(b)}` : a != null ? `≥ ${f(a)}` : `≤ ${f(b)}`);

/** Nice round numbers on a log scale: two significant figures, three above 1,000. */
const roundTo = (v, step) => Math.round(v / step) * step;
const snapBandwidth = v => (v < 1000 ? roundTo(v, 10) : roundTo(v, 50));
const snapMemory = v => (v < 64 ? Math.round(v) : roundTo(v, 4));
const snapPrice = v => (v < 2000 ? roundTo(v, 50) : v < 20000 ? roundTo(v, 250) : roundTo(v, 1000));
const snapDepth = v => Math.max(1024, Math.round(v / 1024) * 1024);
/** Round a catalog extent outward to 1, 2 or 5 times a power of ten. */
function niceBound(v, up) {
  const p = 10 ** Math.floor(Math.log10(v));
  const steps = [1, 2, 5, 10];
  const f = v / p;
  return (up ? steps.find(x => x >= f - 1e-9) : steps.slice().reverse().find(x => x <= f + 1e-9)) * p;
}

try {
  const model = await load();
  const state = readState();

  const vendors = [...new Set(model.UNITS.map(u => u.vendor ?? 'Other'))];

  const matchesNow = () => new Map(model.UNITS.map(u => [u.id, unitMatch(u, state)]));

  // ---- 1. Hardware
  function renderHardware() {
    chips('fmtChips', FORMATS.map(f => ({ v: f, label: FMT_LABEL[f] })), v => state.fmt.has(v), v => {
      state.fmt.has(v) ? state.fmt.delete(v) : state.fmt.add(v);
      // The chart follows the first format asked for, when it can show it.
      const first = [...state.fmt].find(f => SCATTER_PRECS.includes(f));
      if (first) state.scatterPrec = first;
      update('hw');
    });
    el('fmtUnknownOk').checked = state.fmtUnknownOk;
    sliders.bw.set([state.bwMin, state.bwMax]);
    sliders.mem.set([state.memMin, state.memMax]);
    sliders.price.set([state.priceMin, state.priceMax]);
    chips('linkChips', [{ v: null, label: 'any' }, ...LINK_STEPS.map(n => ({ v: n, label: `${n}+ cards` }))], v => state.linkMin === v, v => {
      state.linkMin = v;
      update('hw');
    });
    chips(
      'vendorChips',
      vendors.map(v => ({ v, label: v, title: 'Click to hide or show', dot: vendorColor(v) })),
      v => !state.vendorsOff.has(v),
      v => {
        state.vendorsOff.has(v) ? state.vendorsOff.delete(v) : state.vendorsOff.add(v);
        update('hw');
      },
      v => (state.vendorsOff.has(v) ? 'off' : '')
    );
    chips('scatterPrecChips', SCATTER_PRECS.map(p => ({ v: p, label: FMT_LABEL[p] })), v => state.scatterPrec === v, v => {
      state.scatterPrec = v;
      update('hw');
    });

    const matches = matchesNow();
    const ok = model.UNITS.filter(u => matches.get(u.id).ok);
    const almost = model.UNITS.filter(u => {
      const m = matches.get(u.id);
      return !m.ok && !state.fmtUnknownOk && m.onlyUnknown && unitMatch(u, { ...state, fmtUnknownOk: true }).ok;
    });
    const parts = [];
    if (state.fmt.size) parts.push(`${[...state.fmt].map(f => FMT_LABEL[f]).join(' + ')} matrix support`);
    if (state.bwMin != null || state.bwMax != null) {
      // 1 TiB/s is the one bandwidth people ask for by name.
      const tib = state.bwMin != null && Math.abs(state.bwMin - 1099.511627776) < 0.05 ? ' (1 TiB/s)' : '';
      parts.push(`bandwidth ${spanText([state.bwMin, state.bwMax], gbs)}${tib}`);
    }
    if (state.memMin != null || state.memMax != null) parts.push(`${spanText([state.memMin, state.memMax], v => `${v} GB`)} per card`);
    if (state.priceMin != null || state.priceMax != null) parts.push(`street price ${spanText([state.priceMin, state.priceMax], usd)} (unpriced units drop out)`);
    if (state.linkMin != null) parts.push(`${state.linkMin}+ cards joined without PCIe`);
    if (state.vendorsOff.size) parts.push(`hiding ${[...state.vendorsOff].join(', ')}`);
    // Cards out only because nobody has sourced their link yet.
    const linkUnknown = model.UNITS.filter(u => matches.get(u.id).linkUnknown && unitMatch(u, { ...state, linkMin: null }).ok);
    el('hwSummary').innerHTML =
      `<b>${ok.length}</b> of ${model.UNITS.length} units match${parts.length ? `: ${esc(parts.join(' · '))}` : ' (no filter set)'}.` +
      (almost.length
        ? ` ${almost.length} more would if their unsourced support were confirmed: ${almost.map(u => esc(u.label)).join(', ')}.`
        : '') +
      (linkUnknown.length ? ` ${linkUnknown.length} more ${linkUnknown.length > 1 ? 'have' : 'has'} no sourced link figure yet: ${linkUnknown.map(u => esc(u.label)).join(', ')}.` : '');
    el('hwReset').hidden = !parts.length;

    const sc = renderScatter(model.UNITS, new Set(ok.map(u => u.id)), state.scatterPrec);
    el('scatterCap').textContent = `bandwidth vs dense ${FMT_LABEL[state.scatterPrec]} throughput · ${sc.plotted} of ${model.UNITS.length} units have both figures · ${sc.on} plotted match${sc.vector ? ` · ${sc.vector} at a vector rate (no matrix units)` : ''}${sc.unofficial ? ` · ${sc.unofficial} of the figures are unofficial (hover a point)` : ''}`;
    // The legend names each vendor's colour, then says what solid and faint mean.
    el('scatterLegend').innerHTML =
      vendors.map(v => `<span><span class="swatch" style="background:${esc(vendorColor(v))}"></span>${esc(v)}</span>`).join('') +
      `<span>solid and labelled: matches the filters</span>` +
      `<span><span class="swatch ring"></span>ring: vector rate, no matrix units</span>` +
      `<span><span class="swatch faint" style="background:var(--muted)"></span>faint: filtered out — hover to name it</span>`;
    renderHardwareTable(model, state, matches);
    return ok;
  }

  // ---- 2. Ceilings
  const modelIds = Object.keys(MODELS).filter(id => MODELS[id].params?.active);

  function renderModelCard() {
    const m = MODELS[state.model];
    const t = m.layerTypes;
    const layout = attentionLayout(m);
    const layers = [
      t.full_attention ? `${t.full_attention} full-attention` : '',
      t.sliding_attention ? `${t.sliding_attention} sliding-window (${m.slidingWindow.toLocaleString()})` : '',
      t.linear_attention ? `${t.linear_attention} linear-attention` : '',
    ].filter(Boolean).join(' + ');
    const { bpw } = bpwOf(state.weights);
    const depths = [4096, 32768, 131072, 262144].filter(d => !m.maxPositions || d <= m.maxPositions * 1.01);
    const rows = depths
      .map(d => {
        const b = decodeBytesPerStep(m, { bpw, depth: d, kvK: state.kv, kvV: state.kv });
        if (!b) return '';
        const share = (100 * (b.kv + b.state)) / b.total;
        return `<tr><td class="lbl">${fmtDepth(d)}</td><td class="num">${fmtGiB(b.weights)}</td><td class="num">${fmtGiB(b.kv + b.state)}</td><td class="num">${share.toFixed(0)}%</td></tr>`;
      })
      .join('');
    const moe = m.moe ? `MoE: ${m.moe.experts} experts, ${m.moe.expertsPerToken} routed per token${m.moe.shared ? ` + ${m.moe.shared} shared` : ''}` : 'dense: every weight read per token';
    el('modelCard').innerHTML =
      `<div><div class="k">Shape</div><div class="big">${esc(m.label)}</div>` +
      `<div>${(m.params.total / 1e9).toFixed(1)}B parameters, ${(m.params.active / 1e9).toFixed(1)}B active · ${esc(moe)}</div>` +
      `<div style="margin-top:4px">${m.layers} layers: ${esc(layers)}</div>` +
      `<div>${m.heads} attention heads, ${m.kvHeads} KV heads × ${m.headDim}</div>` +
      `<div style="margin-top:4px"><a href="${esc(m.source)}">config</a>${m.params.source ? ` · <a href="${esc(m.params.source)}">parameter count</a>` : ''}</div></div>` +
      `<div><div class="k">Attention layout</div><div class="big" style="color:${LAYOUT_COLOR()[layout]}">${esc(LAYOUT_LABEL[layout])}</div>` +
      `<div>KV cache grows ${fmtGiB(kvBytesPerToken(m, state.kv) * 1024)} per 1K tokens at ${esc(state.kv)}` +
      `${t.sliding_attention ? `, plus a fixed ${fmtGiB(kvBytesAt(m, m.slidingWindow, state.kv) - kvBytesPerToken(m, state.kv) * m.slidingWindow)} for the sliding layers once past their ${m.slidingWindow.toLocaleString()}-token window` : ''}` +
      `${m.sparse ? `; each step reads at most ${m.sparse.budget.toLocaleString()} positions of it` : ''}` +
      `${recurrentStateBytes(m) ? `; ${fmtGiB(recurrentStateBytes(m))} of fixed recurrent state` : ''}.</div>` +
      (m.note ? `<div style="margin-top:4px">${esc(m.note)}</div>` : '') +
      `</div>` +
      `<div><div class="k">Bytes one decode step reads</div>` +
      `<table><thead><tr><th class="lbl">depth</th><th>weights</th><th>cache + state</th><th>cache share</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function depthSeries() {
    const { bpw } = bpwOf(state.weights);
    const steps = [];
    for (let d = 1024; d <= 1048576; d *= 2) steps.push(d);
    return modelIds.map(id => {
      const m = MODELS[id];
      const base = decodeBytesPerStep(m, { bpw, depth: 0, kvK: state.kv, kvV: state.kv }).total;
      const max = m.maxPositions ?? 262144;
      return {
        id,
        label: m.label,
        layout: attentionLayout(m),
        points: steps.filter(d => d <= max * 1.01).map(d => ({ x: d, y: (100 * base) / decodeBytesPerStep(m, { bpw, depth: d, kvK: state.kv, kvV: state.kv }).total })),
      };
    });
  }

  function renderCeilControls() {
    const sel = el('modelSelect');
    if (!sel.options.length) {
      const groups = { full: [], sliding: [], linear: [] };
      for (const id of modelIds) groups[attentionLayout(MODELS[id])].push(id);
      sel.innerHTML = Object.entries(groups)
        .filter(([, ids]) => ids.length)
        .map(([k, ids]) => `<optgroup label="${esc(LAYOUT_LABEL[k])}">${ids.map(id => `<option value="${id}">${esc(MODELS[id].label)}</option>`).join('')}</optgroup>`)
        .join('');
      sel.onchange = () => {
        state.model = sel.value;
        update('model');
      };
    }
    sel.value = state.model;
    chips('weightChips', WEIGHT_CHOICES.map(w => ({ v: w, label: WEIGHT_FORMATS[w].label, title: WEIGHT_FORMATS[w].note })), v => state.weights === v, v => {
      state.weights = v;
      update('model');
    });
    chips('kvChips', KV_CHOICES.map(k => ({ v: k.id, label: k.label })), v => state.kv === v, v => {
      state.kv = v;
      update('model');
    });
    sliders.depth.set(state.depth);
    el('cardsAuto').checked = state.cards === 'auto';
    sliders.cards.set(state.cards === 'auto' ? lastCards : Number(state.cards), state.cards === 'auto');
    chips('splitChips', [{ v: 'tensor', label: 'Tensor parallel' }, { v: 'layer', label: 'Layer split' }], v => state.split === v, v => {
      state.split = v;
      update('calc');
    });
    chips('scopeChips', [{ v: 'filtered', label: 'Matching section 1' }, { v: 'all', label: 'All units' }], v => state.scope === v, v => {
      state.scope = v;
      update('calc');
    });
  }

  // The model card and depth chart depend only on the model and its formats.
  function renderModelSection() {
    renderModelCard();
    renderDepth(depthSeries(), state.model);
    el('depthCap').textContent = `share of the empty-context decode ceiling left as the context deepens · ${modelIds.length} models`;
    const colors = LAYOUT_COLOR();
    el('depthLegend').innerHTML = Object.entries(LAYOUT_LABEL)
      .map(([k, label]) => `<span><span class="swatch line" style="border-color:${colors[k]}"></span>${esc(label)}</span>`)
      .join('') + `<span style="color:var(--text)">heavier line: ${esc(MODELS[state.model].label)}</span>`;
  }

  function renderCeilTable(hwMatches) {
    const units = state.scope === 'all' ? model.UNITS : model.UNITS.filter(u => hwMatches.has(u.id));
    renderCeilingTable(model, state, units);
  }

  // ---- 3. Observations
  function renderObs() {
    const devices = [...new Set(model.LINES.flatMap(l => l.rig.units.map(u => u.unit)))].sort((a, b) => model.unitById[a].label.localeCompare(model.unitById[b].label));
    const dev = el('obsDevice');
    dev.innerHTML = `<option value="">All devices</option>` + devices.map(id => `<option value="${id}">${esc(model.unitById[id].label)}</option>`).join('');
    dev.value = state.obsDevice;
    dev.onchange = () => {
      state.obsDevice = dev.value;
      update('obs');
    };
    const models = [...new Set(model.LINES.map(l => l.model ?? ''))].sort((a, b) => (MODELS[a]?.label ?? 'zz').localeCompare(MODELS[b]?.label ?? 'zz'));
    const mod = el('obsModel');
    mod.innerHTML = `<option value="">All models</option>` + models.map(id => `<option value="${id || NO_MODEL}">${esc(id ? MODELS[id]?.label ?? id : 'Not recorded')}</option>`).join('');
    mod.value = state.obsModel;
    mod.onchange = () => {
      state.obsModel = mod.value;
      update('obs');
    };
    chips('obsMetricChips', [{ v: 'all', label: 'All' }, { v: 'decode', label: 'Decode' }, { v: 'prefill', label: 'Prefill' }], v => state.obsMetric === v, v => {
      state.obsMetric = v;
      update('obs');
    });
    chips('obsProvChips', [{ v: 'all', label: 'All' }, { v: 'witnessed', label: 'Witnessed' }, { v: 'reported', label: 'Reported' }], v => state.obsProv === v, v => {
      state.obsProv = v;
      update('obs');
    });
    renderObservations(model, state);
  }

  /**
   * Re-render what a change can affect, and nothing else, so a slider drag
   * stays smooth:
   *   hw     hardware filters -- section 1, and the ceiling table it scopes
   *   model  model, weights, cache -- section 2 entire, and the rigs' ceilings
   *   calc   depth, cards, split, scope -- the ceiling table and the rigs
   *   obs    the observation filters -- section 3
   *   all    everything (first load, a pasted link)
   */
  let hwOk = new Set();
  function update(scope = 'all') {
    const all = scope === 'all';
    if (all || scope === 'hw') hwOk = new Set(renderHardware().map(u => u.id));
    if (all || scope !== 'obs') renderCeilControls();
    if (all || scope === 'model') renderModelSection();
    if (all || scope === 'hw' || scope === 'model' || scope === 'calc') renderCeilTable(hwOk);
    if (all || scope === 'obs') renderObs();
    if (all || scope === 'model' || scope === 'calc') renderCandidates(model, state);
    writeState(state);
  }

  // A slider fires on every pixel of a drag; render at most once a frame.
  const pending = new Set();
  const updateSoon = scope => {
    if (pending.has(scope)) return;
    pending.add(scope);
    if (pending.size > 1) return;
    requestAnimationFrame(() => {
      const scopes = [...pending];
      pending.clear();
      scopes.forEach(update);
    });
  };

  // Slider scales come from the catalog's own extents, rounded outward, so a
  // card added beyond today's range is still reachable.
  const extent = (get, pad = 1) => {
    const v = model.UNITS.map(get).filter(x => x > 0);
    return [niceBound(Math.min(...v) / pad, false), niceBound(Math.max(...v) * pad, true)];
  };
  const [bwLo, bwHi] = extent(u => u.memoryBandwidthGBs);
  const [memLo, memHi] = extent(u => u.memoryGB);
  const [priceLo, priceHi] = extent(u => u.street);
  let lastCards = state.cards === 'auto' ? 4 : Number(state.cards);
  const sliders = {
    bw: rangeSlider(el('bwRange'), { min: bwLo, max: bwHi, log: true, snap: snapBandwidth, unit: 'GB/s', label: 'memory bandwidth', onChange: ([a, b], live) => {
      state.bwMin = a;
      state.bwMax = b;
      live ? updateSoon('hw') : update('hw');
    } }),
    mem: rangeSlider(el('memRange'), { min: memLo, max: memHi, log: true, snap: snapMemory, unit: 'GB', label: 'memory per card', onChange: ([a, b], live) => {
      state.memMin = a;
      state.memMax = b;
      live ? updateSoon('hw') : update('hw');
    } }),
    price: rangeSlider(el('priceRange'), { min: priceLo, max: priceHi, log: true, snap: snapPrice, unit: 'USD', label: 'street price per card', onChange: ([a, b], live) => {
      state.priceMin = a;
      state.priceMax = b;
      live ? updateSoon('hw') : update('hw');
    } }),
    depth: slider(el('depthSlider'), { min: DEFAULTS.depthMin, max: DEFAULTS.depthMax, log: true, snap: snapDepth, format: fmtDepth, label: 'context depth', onChange: (v, live) => {
      state.depth = v;
      live ? updateSoon('calc') : update('calc');
    } }),
    cards: slider(el('cardSlider'), { min: 1, max: CARD_STEPS.at(-1), step: 1, format: n => `${n} card${n === 1 ? '' : 's'}`, disabledText: 'fewest', label: 'cards', onChange: (v, live) => {
      lastCards = v;
      state.cards = String(v);
      live ? updateSoon('calc') : update('calc');
    } }),
  };
  el('cardsAuto').addEventListener('change', e => {
    state.cards = e.target.checked ? 'auto' : String(lastCards);
    update('calc');
  });

  // Controls that are not chip rows.
  // Built once and only shown or hidden: a button rebuilt by the render its own
  // click triggers can vanish between mousedown and click.
  el('hwReset').addEventListener('click', () => {
    Object.assign(state, { fmt: new Set(), fmtUnknownOk: false, bwMin: null, bwMax: null, memMin: null, memMax: null, priceMin: null, priceMax: null, linkMin: null, vendorsOff: new Set() });
    update('hw');
  });
  el('fmtUnknownOk').addEventListener('change', e => {
    state.fmtUnknownOk = e.target.checked;
    update('hw');
  });
  // Headers are rebuilt on every render, so the click is delegated.
  el('hwTable').querySelector('thead').addEventListener('click', e => {
    const key = e.target.closest('th')?.dataset.sortkey;
    if (!key) return;
    state.hwSort = state.hwSort.key === key ? { key, dir: state.hwSort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'label' ? 'asc' : 'desc' };
    update('hw');
  });
  window.addEventListener('hashchange', () => {
    // A section link changes the fragment to an anchor: keep the view, and put
    // it back in the address so a copied link still carries it.
    if (!isStateHash(location.hash.slice(1))) return writeState(state);
    Object.assign(state, readState());
    if (state.cards !== 'auto') lastCards = Number(state.cards);
    update();
  });

  update();
} catch (err) {
  fail(err);
}
