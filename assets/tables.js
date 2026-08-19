// DOM rendering for the tables and the platform legend.

import {
  cssConf,
  computeWC,
  fmtT,
  ttBand,
  wcById,
  buildDecode,
  idleYr,
  archOf,
  vendorColor,
  discoveredPrecisions,
} from './derive.js';

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
// Sorting is data-driven for the same reason -- each column carries its own
// accessor beside its own renderer, so a new precision arrives sortable rather
// than needing a matching entry in a hand-maintained list of sort keys.
export function renderSpecTable(model, state) {
  const all = model.UNITS;
  const units = all.filter(u => !state.specHidden.has(u.vendor ?? 'Other'));

  // A sparsity figure is always exactly twice its dense counterpart, so giving
  // each its own column doubles the width to say nothing. Pair them in one cell
  // and the table stays readable.
  const precisions = discoveredPrecisions(all);

  const dash = '<td class="c-n"><span class="num">—</span></td>';
  const num = v => (v == null ? dash : `<td class="num">${v}</td>`);
  const usd = m => (m?.usd == null ? dash : `<td class="num">$${m.usd.toLocaleString()}</td>`);

  /**
   * Dense figure, with its structured-sparsity twin dimmed beneath it. An
   * empty cell means one of two different things, and they read the same to
   * the schema: "nobody has looked" and "confirmed this doesn't exist" --
   * `unknown`/`unsupported` on the unit let a real search's outcome show up
   * as a colored '?' instead of blending into every other blank dash.
   */
  const unknownMark = '<span class="num" style="color:var(--u)" title="Believed supported — no sourced figure found yet">?</span>';
  const throughput = (u, p) => {
    const values = u.compute?.values;
    const dense = values?.[p];
    const sparse = values?.[`${p}:sparse`];
    const denseUnknown = dense == null && u.compute?.unknown?.includes(p);
    if (dense == null && sparse == null) {
      if (denseUnknown) return `<td class="c-u">${unknownMark}</td>`;
      const unsupported = u.compute?.unsupported?.includes(p);
      return unsupported
        ? `<td class="c-n"><span class="num" title="Confirmed unsupported on this part">—</span></td>`
        : dash;
    }
    // Sparse is present but dense specifically isn't -- still worth flagging
    // as unknown rather than a plain dash, distinct from the whole-cell case
    // above since this cell already carries a real (sparse) figure.
    return (
      `<td class="num">${denseUnknown ? unknownMark : (dense ?? '—')}` +
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

  // Each column pairs its renderer with the value a sort should order by, so
  // the two can never drift apart. A column with no `sort` is simply not
  // clickable ("Used in" is prose, and ordering by it means nothing).
  // Named apart from the module-level nameCell(), which takes a platform. Once
  // the vendor grouping is gone, a vendor dot is the only thing left saying who
  // made the part, so it appears exactly when the group rows don't.
  const unitCell = u =>
    '<td class="lbl">' +
    (state.specSort.key
      ? `<span class="pdot" style="display:inline-block;vertical-align:middle;margin-right:7px;background:${vendorColor(u.vendor ?? 'Other')}"></span>`
      : '') +
    `<span style="font-family:var(--mono);font-size:12px">${u.label}</span>` +
    `<span style="display:block;font-size:10px;color:var(--dim)">${u.id}</span></td>`;

  const cols = [
    { key: 'label', label: 'Unit', cls: 'lbl', style: 'min-width:190px', sort: u => u.label, cell: unitCell },
    { key: 'released', label: 'Released', sort: u => u.released, cell: u => num(u.released) },
    { key: 'mem', label: 'Mem GB', sort: u => u.memoryGB, cell: u => num(u.memoryGB) },
    { key: 'bw', label: 'BW GB/s', sort: u => u.memoryBandwidthGBs, cell: u => num(u.memoryBandwidthGBs) },
    { key: 'tdp', label: 'TDP W', sort: u => u.tdpW, cell: u => num(u.tdpW) },
    { key: 'loadW', label: 'Load W', sort: u => u.power?.loadW, cell: u => num(u.power?.loadW) },
    { key: 'idleW', label: 'Idle W', sort: u => u.power?.idleW, cell: u => num(u.power?.idleW) },
    ...precisions.map(p => ({
      key: `prec:${p}`,
      label: p.toUpperCase(),
      // Dense only. A cell showing just a sparse figure has no dense number to
      // rank, and quietly ranking it by its sparse twin would put it two-for-one
      // ahead of every dense figure it is listed beside.
      sort: u => u.compute?.values?.[p],
      cell: u => throughput(u, p),
    })),
    { key: 'msrp', label: 'MSRP', sort: u => u.pricing?.msrp?.usd, cell: u => usd(u.pricing?.msrp) },
    { key: 'street', label: 'Street', sort: u => u.pricing?.street?.usd, cell: u => usd(u.pricing?.street) },
    {
      label: 'Used in',
      cls: 'lbl',
      cell: u =>
        `<td class="lbl" style="white-space:normal;max-width:200px"><span style="font-size:11px;color:var(--dim)">${(usage[u.id] ?? []).join(' · ') || '—'}</span></td>`,
    },
  ];

  // The column set follows the data, so a sort key can outlive its column if a
  // precision is removed from compendium.json. Fall back rather than throw.
  let active = state.specSort.key ? cols.find(c => c.key === state.specSort.key) : null;
  if (!active) state.specSort.key = null;

  document.querySelector('#specTable thead tr').innerHTML = cols
    .map(c => {
      const on = state.specSort.key === c.key;
      const cls = [c.cls, c.sort ? 'sortable' : null, on ? 'sorted' : null].filter(Boolean).join(' ');
      const arrow = on ? (state.specSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
      return (
        '<th' +
        (cls ? ` class="${cls}"` : '') +
        (c.style ? ` style="${c.style}"` : '') +
        (c.sort
          ? ` data-sortkey="${c.key}" title="Sort by ${c.label} — click again to reverse, once more to return to vendor grouping"`
          : '') +
        `>${c.label}${arrow}</th>`
      );
    })
    .join('');

  const tb = tbody('#specTable');
  tb.innerHTML = '';
  const row = u => {
    const tr = document.createElement('tr');
    tr.innerHTML = cols.map(c => c.cell(u)).join('');
    tb.appendChild(tr);
  };

  if (!units.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="lbl" colspan="${cols.length}" style="color:var(--dim);padding:14px 10px">Every vendor is filtered out — click a vendor above to bring it back.</td>`;
    tb.appendChild(tr);
  } else if (active) {
    for (const u of sortUnits(units, active, state.specSort.dir)) row(u);
  } else {
    for (const vendor of [...new Set(units.map(u => u.vendor ?? 'Other'))]) {
      const gr = document.createElement('tr');
      gr.innerHTML = groupRow(cols.length, vendor);
      tb.appendChild(gr);
      for (const u of units.filter(x => (x.vendor ?? 'Other') === vendor)) row(u);
    }
  }

  const shown = units.length === all.length ? '' : ` Showing ${units.length} of ${all.length} units.`;
  const sorted = active
    ? ` Sorted by ${active.label}, ${state.specSort.dir === 'desc' ? 'highest' : 'lowest'} first — blanks sort last in both directions, because an unknown figure is not a zero one.`
    : ' Click any column heading to sort by it.';
  el('specUnits').textContent = precisions.length
    ? `Rated throughput in 10¹² ops/sec. Large figure is dense; the dimmed "sp" beneath it is the 2:4 structured-sparsity rate, which vendors often quote unlabelled. A blue "?" means a real search came up empty — believed supported, no sourced figure yet; a plain dash means either confirmed unsupported or simply not yet researched. Load and idle watts are per unit, observed under inference — not the datasheet TDP beside them.${sorted}${shown}`
    : `No rated-throughput figures transcribed yet — add compute.values to any unit in data/compendium.json and a column appears here automatically. Load and idle watts are per unit, observed under inference, not datasheet TDP.${sorted}${shown}`;
}

/**
 * Missing values sort last in *both* directions. Ascending-with-nulls-first
 * would open every numeric column on a wall of blanks and bury the data the
 * sort was asked for -- the same reason the catalog renders unknowns as blanks
 * rather than zeroes.
 */
function sortUnits(units, col, dir) {
  return [...units].sort((a, b) => {
    const va = col.sort(a) ?? null;
    const vb = col.sort(b) ?? null;
    if (va === null && vb === null) return a.label.localeCompare(b.label);
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp =
      typeof va === 'string' || typeof vb === 'string'
        ? String(va).localeCompare(String(vb))
        : va - vb;
    return dir === 'desc' ? -cmp : cmp;
  });
}

/**
 * Heading clicks cycle descending → ascending → off. The third click matters:
 * it is the only way back to the vendor grouping, which is the view that shows
 * what the catalog *is* rather than how one column ranks.
 */
export function cycleSpecSort(state, key) {
  const s = state.specSort;
  if (s.key !== key) {
    s.key = key;
    s.dir = 'desc';
  } else if (s.dir === 'desc') {
    s.dir = 'asc';
  } else {
    s.key = null;
    s.dir = 'desc';
  }
}

// === Precision toggle: one button per precision the catalog has data for ===
// Rebuilt on every render because the set of available precisions is data-
// driven (a new key in compendium.json grows a new button with no code
// change), unlike the fixed view/archetype toggles that are hand-authored in
// index.html. Click handling is delegated once in app.js rather than rebound
// here on every rebuild.
export function renderPrecisionToggle(model, state) {
  const precisions = discoveredPrecisions(model.UNITS);
  if (!precisions.includes(state.precision)) {
    // Default to whichever precision the most units actually have, so the
    // chart opens non-empty rather than on an arbitrary first column.
    const richest = precisions
      .map(p => ({
        p,
        n: model.UNITS.filter(u => u.compute?.values?.[p] != null || u.compute?.values?.[`${p}:sparse`] != null).length,
      }))
      .sort((a, b) => b.n - a.n)[0];
    state.precision = richest?.p ?? precisions[0] ?? null;
  }
  const host = el('precTg');
  host.innerHTML = precisions
    .map(p => `<button data-prec="${p}"${p === state.precision ? ' class="on"' : ''}>${p.toUpperCase()}</button>`)
    .join('');
}

// === Vendor chips: click to hide/show ===
// The precision chart and the catalog table both filter by vendor, but each
// keeps its own hidden-set: hiding NVIDIA to read the chart shouldn't silently
// empty the table you scroll back up to.
function vendorChips(hostId, model, hidden, onToggle) {
  const host = el(hostId);
  host.innerHTML = '';
  for (const v of [...new Set(model.UNITS.map(u => u.vendor ?? 'Other'))]) {
    const sp = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'pdot';
    dot.style.background = vendorColor(v);
    sp.append(dot, document.createTextNode(v));
    sp.style.opacity = hidden.has(v) ? 0.3 : 1;
    sp.onclick = () => {
      if (hidden.has(v)) hidden.delete(v);
      else hidden.add(v);
      sp.style.opacity = hidden.has(v) ? 0.3 : 1;
      onToggle();
    };
    host.appendChild(sp);
  }
}

/** Vendor legend for the precision chart. */
export function renderVendorLegend(model, state, onToggle) {
  vendorChips('precLeg', model, state.precHidden, onToggle);
}

/** Vendor filter for the hardware catalog table. */
export function renderSpecFilter(model, state, onToggle) {
  vendorChips('specLeg', model, state.specHidden, onToggle);
}
