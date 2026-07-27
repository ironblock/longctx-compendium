// DOM rendering for the tables and the platform legend.

import { cssConf, computeWC, fmtT, ttBand, wcById, buildDecode, idleYr, archOf } from './derive.js';

const el = id => document.getElementById(id);
const tbody = sel => document.querySelector(`${sel} tbody`);
const groupsOf = model => [...new Set(model.PLAT.map(p => p.group))];

const nameCell = (p, extra = '') =>
  `<td class="lbl"${extra}><span style="font-family:var(--mono);font-size:12px;color:${p.color};font-weight:700">${p.short}</span>` +
  `<span style="display:block;font-size:10px;color:var(--dim)">${p.label}</span></td>`;

const groupRow = (span, g) =>
  `<td colspan="${span}" class="grp lbl" style="padding:6px 10px">${g}</td>`;

/** A measured-but-secondary value gets a trailing tilde rather than its own colour. */
const tilde = c => (c === 'm~' ? '<span style="color:var(--dim)">~</span>' : '');

// === Clickable colour key that filters the prefill chart ===
export function renderLegend(model, state, onToggle) {
  const host = el('pleg');
  host.innerHTML = '';
  for (const g of groupsOf(model)) {
    const label = document.createElement('span');
    label.style.cssText =
      'color:var(--dim);font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;margin-right:4px';
    label.textContent = g + ':';
    host.appendChild(label);

    for (const p of model.PLAT.filter(x => x.group === g)) {
      const sp = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'pdot';
      dot.style.background = p.color;
      sp.append(dot, document.createTextNode(p.short));
      sp.onclick = () => {
        if (state.hidden.has(p.id)) state.hidden.delete(p.id);
        else state.hidden.add(p.id);
        sp.style.opacity = state.hidden.has(p.id) ? 0.3 : 1;
        onToggle();
      };
      host.appendChild(sp);
    }
  }
}

// === Prefill grid: platform × archetype × context ===
export function renderPrefillTable(model) {
  const tb = tbody('#ppTable');
  tb.innerHTML = '';
  const archIds = model.ARCHETYPES.map(a => a.id);
  const shortLabel = { moe: 'MoE', dense: 'Dense', oss120b: '120B' };

  for (const g of groupsOf(model)) {
    const gr = document.createElement('tr');
    gr.innerHTML = groupRow(2 + model.CTX.length, g);
    tb.appendChild(gr);

    for (const p of model.PLAT.filter(x => x.group === g)) {
      archIds.forEach((arch, ai) => {
        const d = model.PP[arch][p.id];
        const tr = document.createElement('tr');
        const platCell =
          ai === 0
            ? nameCell(p, ` rowspan="${archIds.length}" style="vertical-align:top;border-right:1px solid var(--line)"`)
            : '';
        const archCell = `<td class="lbl"><span style="font-size:11px;color:var(--muted)">${shortLabel[arch] ?? arch}</span></td>`;
        const cells = d.v
          .map((val, i) => {
            const c = d.c[i];
            if (c === 'n') return '<td class="c-n"><span class="num">—</span></td>';
            return `<td class="c-${cssConf(c)}"><span class="num">${val ? Math.round(val) : '—'}</span>${tilde(c)}</td>`;
          })
          .join('');
        tr.innerHTML = platCell + archCell + cells;
        tb.appendChild(tr);
      });
    }
  }
}

// === Decode rate and wall-clock summary ===
export function renderDecodeTable(model) {
  const tb = tbody('#tgTable');
  tb.innerHTML = '';
  const wcMoe = wcById(model, 'moe');
  const wcDense = wcById(model, 'dense');

  const tgCell = (v, c) => {
    if (!v || c === 'n') return '<td class="c-n"><span class="num">—</span></td>';
    return `<td class="c-${cssConf(c)}"><span class="num">${v.toFixed(1)}</span>${tilde(c)}</td>`;
  };
  const v32Cell = v =>
    v ? `<td class="c-m"><span class="num">${v.toFixed(1)}</span></td>` : '<td class="c-n">—</td>';
  const wcCell = w => {
    if (!w || !w.total) return '<td class="c-n">—</td>';
    return (
      `<td class="c-${w.est ? 'e' : 'm'}"><span class="num ${ttBand(w.total)}">${fmtT(w.total)}</span>` +
      `<span style="display:block;font-size:10px;color:var(--dim)">${fmtT(w.ttft)} + ${fmtT(w.gen)}</span></td>`
    );
  };

  for (const g of groupsOf(model)) {
    const gr = document.createElement('tr');
    gr.innerHTML = groupRow(8, g);
    tb.appendChild(gr);

    for (const p of model.PLAT.filter(x => x.group === g)) {
      const tm = model.TG.moe[p.id];
      const td = model.TG.dense[p.id];
      const tr = document.createElement('tr');
      tr.innerHTML =
        nameCell(p) +
        tgCell(tm.v, tm.c) +
        v32Cell(tm.v32) +
        tgCell(td.v, td.c) +
        v32Cell(td.v32) +
        wcCell(wcMoe[p.id]) +
        wcCell(wcDense[p.id]) +
        `<td class="lbl" style="max-width:220px;white-space:normal"><span style="font-size:11px;color:var(--dim)">${tm.note}</span></td>`;
      tb.appendChild(tr);
    }
  }
}

// === Build value ===
export function renderValueTable(model, state) {
  const tb = tbody('#valTable');
  tb.innerHTML = '';
  const arch = archOf(state.valModel);
  const rows = model.BUILDS.filter(b => buildDecode(model, b, arch).v).sort((a, b) => {
    const da = buildDecode(model, a, arch).v;
    const db = buildDecode(model, b, arch).v;
    return db / (b.cost / 1000) - da / (a.cost / 1000);
  });

  for (const b of rows) {
    const dec = buildDecode(model, b, arch);
    const d120 = buildDecode(model, b, 'oss120b');
    const dMoe = buildDecode(model, b, 'moe');
    const tr = document.createElement('tr');
    tr.innerHTML =
      nameCell(b) +
      `<td class="num">$${b.cost.toLocaleString()}</td>` +
      `<td class="num">${b.loadW}</td>` +
      `<td class="num">${b.idleW}</td>` +
      `<td class="c-${cssConf(d120.c)}"><span class="num">${d120.v ?? '—'}</span></td>` +
      `<td class="c-${cssConf(dMoe.c)}"><span class="num">${dMoe.v ?? '—'}</span></td>` +
      `<td class="num">${(dec.v / (b.cost / 1000)).toFixed(1)}</td>` +
      `<td class="num">${(dec.v / b.loadW).toFixed(2)}</td>` +
      `<td class="num">$${Math.round(idleYr(model, b.idleW))}</td>`;
    tb.appendChild(tr);
  }
}

// === Hardware catalog ===
// One row per purchasable unit, which is what a datasheet or a Wikipedia table
// actually describes. Platforms and builds are quantities of these, so a price
// or spec corrected here corrects everything containing it.
//
// Columns for rated throughput are discovered from the data: add a precision
// key to any unit's compute.values and a column appears with no code change.
// Widest-to-narrowest, so the columns read the way a datasheet does.
const PRECISION_ORDER = ['fp64', 'fp32', 'tf32', 'bf16', 'fp16', 'fp8', 'fp4', 'int8', 'int4'];

export function renderSpecTable(model) {
  const units = model.UNITS;

  // A sparsity figure is always exactly twice its dense counterpart, so giving
  // each its own column doubles the width to say nothing. Pair them in one cell
  // and the table stays readable.
  const seen = new Set(units.flatMap(u => Object.keys(u.compute?.values ?? {})));
  const precisions = [
    ...PRECISION_ORDER.filter(p => seen.has(p) || seen.has(`${p}:sparse`)),
    ...[...seen].map(k => k.replace(':sparse', '')).filter(p => !PRECISION_ORDER.includes(p)),
  ].filter((p, i, a) => a.indexOf(p) === i);

  document.querySelector('#specTable thead tr').innerHTML =
    '<th class="lbl" style="min-width:190px">Unit</th>' +
    '<th>Released</th><th>Mem GB</th><th>BW GB/s</th><th>TDP W</th><th>Load W</th><th>Idle W</th>' +
    precisions.map(x => `<th>${x.toUpperCase()}</th>`).join('') +
    '<th>MSRP</th><th>Street</th>' +
    '<th class="lbl">Used in</th>';

  const tb = tbody('#specTable');
  tb.innerHTML = '';
  const dash = '<td class="c-n"><span class="num">—</span></td>';
  const num = v => (v == null ? dash : `<td class="num">${v}</td>`);
  const usd = m => (m?.usd == null ? dash : `<td class="num">$${m.usd.toLocaleString()}</td>`);

  /** Dense figure, with its structured-sparsity twin dimmed beneath it. */
  const throughput = (values, p) => {
    const dense = values?.[p];
    const sparse = values?.[`${p}:sparse`];
    if (dense == null && sparse == null) return dash;
    return (
      `<td class="num">${dense ?? '—'}` +
      (sparse == null ? '' : `<span style="display:block;font-size:10px;color:var(--dim)">${sparse} sp</span>`) +
      '</td>'
    );
  };

  // Where each unit is used, so the catalog explains itself.
  const usage = {};
  for (const p of model.raw.platforms) {
    for (const c of p.composition ?? []) {
      (usage[c.unit] ??= []).push(`${c.count}× ${p.display.short}`);
    }
  }
  for (const b of model.raw.builds ?? []) {
    for (const u of b.units ?? []) {
      if (u.unit) (usage[u.unit] ??= []).push(`${u.count ?? 1}× ${b.display.short}`);
    }
  }

  const colspan = 10 + precisions.length;
  for (const vendor of [...new Set(units.map(u => u.vendor ?? 'Other'))]) {
    const gr = document.createElement('tr');
    gr.innerHTML = groupRow(colspan, vendor);
    tb.appendChild(gr);

    for (const u of units.filter(x => (x.vendor ?? 'Other') === vendor)) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="lbl"><span style="font-family:var(--mono);font-size:12px">${u.label}</span>` +
        `<span style="display:block;font-size:10px;color:var(--dim)">${u.id}</span></td>` +
        num(u.released) +
        num(u.memoryGB) +
        num(u.memoryBandwidthGBs) +
        num(u.tdpW) +
        num(u.power?.loadW) +
        num(u.power?.idleW) +
        precisions.map(x => throughput(u.compute?.values, x)).join('') +
        usd(u.pricing?.msrp) +
        usd(u.pricing?.street) +
        `<td class="lbl" style="white-space:normal;max-width:200px"><span style="font-size:11px;color:var(--dim)">${(usage[u.id] ?? []).join(' · ') || '—'}</span></td>`;
      tb.appendChild(tr);
    }
  }

  el('specUnits').textContent = precisions.length
    ? `Rated throughput in 10¹² ops/sec. Large figure is dense; the dimmed "sp" beneath it is the 2:4 structured-sparsity rate, which vendors often quote unlabelled. Load and idle watts are per unit, observed under inference — not the datasheet TDP beside them. Blank cells are untranscribed, not zero.`
    : 'No rated-throughput figures transcribed yet — add compute.values to any unit in data/compendium.json and a column appears here automatically. Load and idle watts are per unit, observed under inference, not datasheet TDP.';
}
