// Entry point: loads the data, owns the view state (mirrored into the page
// address so any view can be shared as a link), and wires the controls.
// Everything it renders is a pure function of (model, state).

import { load, FORMATS } from './data.js';
import { MODELS } from './models.js';
import {
  WEIGHT_FORMATS,
  WEIGHT_CHOICES,
  KV_CHOICES,
  DEPTH_CHOICES,
  CARD_STEPS,
  attentionLayout,
  LAYOUT_LABEL,
  decodeBytesPerStep,
  kvBytesAt,
  recurrentStateBytes,
  bpwOf,
  fmtGiB,
} from './ceiling.js';
import { renderScatter, renderDepth, LAYOUT_COLOR } from './charts.js';
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
const BW_PRESETS = [
  { v: null, label: 'Any' },
  { v: 500, label: '500 GB/s' },
  { v: 1000, label: '1 TB/s' },
  { v: 1099.511627776, label: '1 TiB/s' },
  { v: 2000, label: '2 TB/s' },
  { v: 4000, label: '4 TB/s' },
];
const MEM_PRESETS = [null, 24, 32, 48, 80, 128];
const PRICE_PRESETS = [null, 1000, 2000, 5000, 10000];
const SCATTER_PRECS = ['fp16', 'bf16', 'fp8', 'int8', 'fp4'];

const DEFAULTS = {
  fmt: [],
  fmtUnknownOk: false,
  bw: null,
  mem: null,
  price: null,
  vendorsOff: [],
  scatterPrec: 'fp16',
  hwSort: 'bw:desc',
  model: 'qwen38_27b',
  weights: 'q4_k_m',
  kv: 'f16',
  depth: 131072,
  cards: 'auto',
  split: 'tensor',
  scope: 'filtered',
  obsDevice: '',
  obsModel: '',
  obsMetric: 'all',
  obsProv: 'all',
};

// --- state <-> address --------------------------------------------------------

function readState() {
  const q = new URLSearchParams(location.hash.slice(1));
  const num = k => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : DEFAULTS[k]);
  const str = (k, allowed) => (q.has(k) && (!allowed || allowed.includes(q.get(k))) ? q.get(k) : DEFAULTS[k]);
  const list = k => (q.get(k) ? q.get(k).split(',').filter(Boolean) : DEFAULTS[k]);
  const [sk, sd] = str('sort').split(':');
  return {
    fmt: new Set(list('fmt').filter(f => FORMATS.includes(f))),
    fmtUnknownOk: q.get('unk') === '1',
    bw: num('bw'),
    mem: num('mem'),
    price: num('price'),
    vendorsOff: new Set(list('voff')),
    // With no chart precision in the address, the chart follows the first format asked for.
    scatterPrec: q.has('prec') ? str('prec', SCATTER_PRECS) : list('fmt').find(f => SCATTER_PRECS.includes(f)) ?? DEFAULTS.scatterPrec,
    hwSort: { key: sk, dir: sd === 'asc' ? 'asc' : 'desc' },
    model: str('model', Object.keys(MODELS)),
    weights: str('w', WEIGHT_CHOICES),
    kv: str('kv', KV_CHOICES.map(k => k.id)),
    depth: DEPTH_CHOICES.includes(num('d')) ? num('d') : DEFAULTS.depth,
    cards: str('n', ['auto', ...CARD_STEPS.map(String)]),
    split: str('split', ['tensor', 'layer']),
    scope: str('scope', ['filtered', 'all']),
    obsDevice: str('od'),
    obsModel: str('om'),
    obsMetric: str('omet', ['all', 'decode', 'prefill']),
    obsProv: str('oprov', ['all', 'witnessed', 'reported']),
  };
}
// The keys DEFAULTS uses under their address names.
Object.assign(DEFAULTS, { sort: DEFAULTS.hwSort, voff: DEFAULTS.vendorsOff, prec: DEFAULTS.scatterPrec, w: DEFAULTS.weights, d: DEFAULTS.depth, n: DEFAULTS.cards, od: '', om: '', omet: 'all', oprov: 'all' });

function writeState(s) {
  const q = new URLSearchParams();
  const put = (k, v, def) => {
    if (v != null && v !== '' && String(v) !== String(def)) q.set(k, v);
  };
  put('fmt', [...s.fmt].join(','), '');
  if (s.fmtUnknownOk) q.set('unk', '1');
  put('bw', s.bw, null);
  put('mem', s.mem, null);
  put('price', s.price, null);
  put('voff', [...s.vendorsOff].join(','), '');
  put('prec', s.scatterPrec, DEFAULTS.scatterPrec);
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
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// --- controls -------------------------------------------------------------------

/** A row of chip buttons. `isOn(v)` decides the pressed state; `onPick(v)` handles a press. */
function chips(id, items, isOn, onPick, cls = () => '') {
  const host = el(id);
  host.innerHTML = items
    .map((it, i) => `<button type="button" data-i="${i}" class="${isOn(it.v) ? 'on' : ''} ${cls(it.v)}" aria-pressed="${isOn(it.v)}"${it.title ? ` title="${esc(it.title)}"` : ''}>${esc(it.label)}</button>`)
    .join('');
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

const usdShort = v => (v >= 1000 ? `$${v / 1000}k` : `$${v}`);

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
      update();
    });
    el('fmtUnknownOk').checked = state.fmtUnknownOk;
    chips('bwChips', BW_PRESETS, v => state.bw === v, v => {
      state.bw = v;
      update();
    });
    el('bwInput').value = state.bw != null && !BW_PRESETS.some(p => p.v === state.bw) ? state.bw : '';
    chips('memChips', MEM_PRESETS.map(v => ({ v, label: v == null ? 'Any' : `${v} GB` })), v => state.mem === v, v => {
      state.mem = v;
      update();
    });
    chips('priceChips', PRICE_PRESETS.map(v => ({ v, label: v == null ? 'Any' : usdShort(v) })), v => state.price === v, v => {
      state.price = v;
      update();
    });
    chips(
      'vendorChips',
      vendors.map(v => ({ v, label: v, title: 'Click to hide or show' })),
      v => !state.vendorsOff.has(v),
      v => {
        state.vendorsOff.has(v) ? state.vendorsOff.delete(v) : state.vendorsOff.add(v);
        update();
      },
      v => (state.vendorsOff.has(v) ? 'off' : '')
    );
    chips('scatterPrecChips', SCATTER_PRECS.map(p => ({ v: p, label: FMT_LABEL[p] })), v => state.scatterPrec === v, v => {
      state.scatterPrec = v;
      update();
    });

    const matches = matchesNow();
    const ok = model.UNITS.filter(u => matches.get(u.id).ok);
    const almost = model.UNITS.filter(u => {
      const m = matches.get(u.id);
      return !m.ok && !state.fmtUnknownOk && m.onlyUnknown && unitMatch(u, { ...state, fmtUnknownOk: true }).ok;
    });
    const parts = [];
    if (state.fmt.size) parts.push(`${[...state.fmt].map(f => FMT_LABEL[f]).join(' + ')} matrix support`);
    if (state.bw != null) {
      const preset = BW_PRESETS.find(p => p.v === state.bw);
      parts.push(preset && preset.label.includes('TiB') ? `≥ ${preset.label} (${state.bw.toFixed(1)} GB/s)` : `≥ ${Math.round(state.bw).toLocaleString()} GB/s`);
    }
    if (state.mem != null) parts.push(`≥ ${state.mem} GB per card`);
    if (state.price != null) parts.push(`≤ ${usdShort(state.price)} street (unpriced units drop out)`);
    if (state.vendorsOff.size) parts.push(`hiding ${[...state.vendorsOff].join(', ')}`);
    el('hwSummary').innerHTML =
      `<b>${ok.length}</b> of ${model.UNITS.length} units match${parts.length ? `: ${esc(parts.join(' · '))}` : ' (no filter set)'}.` +
      (almost.length
        ? ` ${almost.length} more would if their unsourced support were confirmed: ${almost.map(u => esc(u.label)).join(', ')}.`
        : '') +
      (parts.length ? ' <button type="button" id="hwReset">Clear filters</button>' : '');
    el('hwReset')?.addEventListener('click', () => {
      Object.assign(state, { fmt: new Set(), fmtUnknownOk: false, bw: null, mem: null, price: null, vendorsOff: new Set() });
      update();
    });

    const sc = renderScatter(model.UNITS, new Set(ok.map(u => u.id)), state.scatterPrec);
    el('scatterCap').textContent = `bandwidth vs dense ${FMT_LABEL[state.scatterPrec]} throughput · ${sc.plotted} of ${model.UNITS.length} units have both figures · ${sc.on} plotted match`;
    el('scatterLegend').innerHTML =
      `<span><span class="swatch" style="background:var(--s1)"></span>matches the filter (labelled)</span>` +
      `<span><span class="swatch" style="background:var(--mute-mark)"></span>everything else — hover to name it</span>`;
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
      `<div>KV cache: ${fmtGiB(kvBytesAt(m, 1024, state.kv))} per 1K tokens at ${esc(state.kv)}` +
      `${t.sliding_attention ? `; sliding layers stop growing at ${m.slidingWindow.toLocaleString()}` : ''}` +
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

  function renderCeilings(hwMatches) {
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
        update();
      };
    }
    sel.value = state.model;
    chips('weightChips', WEIGHT_CHOICES.map(w => ({ v: w, label: WEIGHT_FORMATS[w].label, title: WEIGHT_FORMATS[w].note })), v => state.weights === v, v => {
      state.weights = v;
      update();
    });
    chips('kvChips', KV_CHOICES.map(k => ({ v: k.id, label: k.label })), v => state.kv === v, v => {
      state.kv = v;
      update();
    });
    chips('depthChips', DEPTH_CHOICES.map(d => ({ v: d, label: fmtDepth(d) })), v => state.depth === v, v => {
      state.depth = v;
      update();
    });
    chips('cardChips', [{ v: 'auto', label: 'Fewest that fit', title: 'The fewest of 1, 2, 4 or 8 cards that hold the model at this depth' }, ...CARD_STEPS.map(n => ({ v: String(n), label: String(n) }))], v => state.cards === v, v => {
      state.cards = v;
      update();
    });
    chips('splitChips', [{ v: 'tensor', label: 'Tensor parallel' }, { v: 'layer', label: 'Layer split' }], v => state.split === v, v => {
      state.split = v;
      update();
    });
    chips('scopeChips', [{ v: 'filtered', label: 'Matching section 1' }, { v: 'all', label: 'All units' }], v => state.scope === v, v => {
      state.scope = v;
      update();
    });
    renderModelCard();
    renderDepth(depthSeries(), state.model);
    el('depthCap').textContent = `share of the empty-context decode ceiling left as the context deepens · ${modelIds.length} models`;
    const colors = LAYOUT_COLOR();
    el('depthLegend').innerHTML = Object.entries(LAYOUT_LABEL)
      .map(([k, label]) => `<span><span class="swatch line" style="border-color:${colors[k]}"></span>${esc(label)}</span>`)
      .join('') + `<span style="color:var(--text)">heavier line: ${esc(MODELS[state.model].label)}</span>`;
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
      update();
    };
    const models = [...new Set(model.LINES.map(l => l.model ?? ''))].sort((a, b) => (MODELS[a]?.label ?? 'zz').localeCompare(MODELS[b]?.label ?? 'zz'));
    const mod = el('obsModel');
    mod.innerHTML = `<option value="">All models</option>` + models.map(id => `<option value="${id}">${esc(id ? MODELS[id]?.label ?? id : 'Not recorded')}</option>`).join('');
    mod.value = state.obsModel;
    mod.onchange = () => {
      state.obsModel = mod.value;
      update();
    };
    chips('obsMetricChips', [{ v: 'all', label: 'All' }, { v: 'decode', label: 'Decode' }, { v: 'prefill', label: 'Prefill' }], v => state.obsMetric === v, v => {
      state.obsMetric = v;
      update();
    });
    chips('obsProvChips', [{ v: 'all', label: 'All' }, { v: 'witnessed', label: 'Witnessed' }, { v: 'reported', label: 'Reported' }], v => state.obsProv === v, v => {
      state.obsProv = v;
      update();
    });
    renderObservations(model, state);
  }

  function update() {
    const ok = renderHardware();
    renderCeilings(new Set(ok.map(u => u.id)));
    renderObs();
    renderCandidates(model, state);
    writeState(state);
  }

  // Controls that are not chip rows.
  el('fmtUnknownOk').addEventListener('change', e => {
    state.fmtUnknownOk = e.target.checked;
    update();
  });
  el('bwInput').addEventListener('change', e => {
    const v = Number(e.target.value);
    state.bw = e.target.value === '' || !(v > 0) ? null : v;
    update();
  });
  // Headers are rebuilt on every render, so the click is delegated.
  el('hwTable').querySelector('thead').addEventListener('click', e => {
    const key = e.target.closest('th')?.dataset.sortkey;
    if (!key) return;
    state.hwSort = state.hwSort.key === key ? { key, dir: state.hwSort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'label' ? 'asc' : 'desc' };
    update();
  });
  window.addEventListener('hashchange', () => {
    Object.assign(state, readState());
    update();
  });

  update();
} catch (err) {
  fail(err);
}
