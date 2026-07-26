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

// === Hardware specifications ===
// Columns for rated throughput are discovered from the data: add a precision
// key to any platform's hardware.compute.values and a column appears here with
// no code change.
export function renderSpecTable(model) {
  const platforms = model.raw.platforms;
  const precisions = [...new Set(platforms.flatMap(p => Object.keys(p.hardware?.compute?.values ?? {})))];

  const head = document.querySelector('#specTable thead tr');
  head.innerHTML =
    '<th class="lbl" style="min-width:170px">Platform</th>' +
    '<th class="lbl">Vendor</th><th>Released</th><th>Mem GB</th><th>BW GB/s</th><th>TDP W</th>' +
    precisions.map(x => `<th>${x.toUpperCase()}</th>`).join('') +
    '<th>MSRP</th><th>Street</th>';

  const tb = tbody('#specTable');
  tb.innerHTML = '';
  const dash = '<td class="c-n"><span class="num">—</span></td>';
  const num = v => (v == null ? dash : `<td class="num">${v}</td>`);
  const usd = m => (m?.usd == null ? dash : `<td class="num">$${m.usd.toLocaleString()}</td>`);

  const platMap = Object.fromEntries(model.PLAT.map(p => [p.id, p]));
  for (const g of groupsOf(model)) {
    const gr = document.createElement('tr');
    gr.innerHTML = groupRow(8 + precisions.length, g);
    tb.appendChild(gr);

    for (const p of model.PLAT.filter(x => x.group === g)) {
      const src = platforms.find(x => x.id === p.id);
      const hw = src.hardware ?? {};
      const values = hw.compute?.values ?? {};
      const tr = document.createElement('tr');
      tr.innerHTML =
        nameCell(platMap[p.id]) +
        `<td class="lbl"><span style="font-size:11px;color:var(--muted)">${hw.vendor ?? '—'}</span></td>` +
        num(hw.released) +
        num(hw.memoryGB) +
        num(hw.memoryBandwidthGBs) +
        num(hw.tdpW) +
        precisions.map(x => num(values[x])).join('') +
        usd(src.pricing?.msrp) +
        usd(src.pricing?.street);
      tb.appendChild(tr);
    }
  }

  // Only advertise the unit line once real figures exist.
  el('specUnits').textContent = precisions.length
    ? `Rated throughput in ${platforms.find(p => p.hardware?.compute?.unit)?.hardware.compute.unit ?? 'Tops'} (10¹² ops/sec), dense unless noted. Blank cells are untranscribed, not zero.`
    : 'No rated-throughput figures transcribed yet — add hardware.compute.values to any platform in data/compendium.json and a column appears here automatically.';
}
