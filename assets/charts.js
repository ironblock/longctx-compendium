// Chart.js configuration for the four views. Each builder is idempotent: it
// mutates the existing chart when one exists so toggling a view never leaks a
// canvas.

import {
  computeWC,
  computeSteadyState,
  STEADY_STATE_AT_CTX,
  STEADY_STATE_TOKENS,
  fmtT,
  hexA,
  platColor,
  buildDecode,
  idleYr,
  rankedBuilds,
  vendorColor,
  precisionRows,
  precisionUnitLabel,
} from './derive.js';

const GRID = 'rgba(255,255,255,.07)';
const TICKC = '#5a6a7d';
const MONO = { family: 'Space Mono', size: 11 };
const MONO_S = { family: 'Space Mono', size: 10 };

const TOOLTIP = {
  backgroundColor: '#0d1724',
  borderColor: '#1a2535',
  borderWidth: 1,
  titleColor: '#ccd6e0',
  bodyColor: '#8898a9',
  titleFont: MONO,
  bodyFont: MONO,
};

const axis = (text, extra = {}) => ({
  title: { display: true, text, color: TICKC, font: MONO },
  grid: { color: GRID },
  ticks: { color: TICKC, font: MONO_S },
  ...extra,
});

const charts = {};

function paint(key, canvasId, cfg, replaceOptions = false) {
  if (charts[key]) {
    charts[key].data = cfg.data;
    if (replaceOptions) charts[key].options = cfg.options;
    charts[key].update();
  } else {
    charts[key] = new Chart(document.getElementById(canvasId), cfg);
  }
  return charts[key];
}

// === Prefill falloff: throughput against context length ===
export function renderPrefill(model, state) {
  const data = model.PP[state.arch];
  const datasets = model.PLAT.map(p => {
    const d = data[p.id];
    const vals = d.v.map((v, i) => (d.c[i] === 'n' ? null : v));
    const allModeled = d.c.every(c => c === 'i' || c === 'n');
    return {
      label: p.short,
      data: vals,
      borderColor: p.color,
      backgroundColor: p.color,
      borderWidth: 2.2,
      tension: 0.25,
      spanGaps: false,
      pointRadius: 4,
      pointHoverRadius: 6,
      // Hollow points mark anything that was not directly measured.
      pointBackgroundColor: vals.map((v, i) => (d.c[i] === 'm' ? p.color : 'transparent')),
      pointBorderColor: p.color,
      pointBorderWidth: 2,
      hidden: state.hidden.has(p.id),
      borderDash: allModeled ? [2, 4] : undefined,
      segment: allModeled
        ? undefined
        : {
            borderDash: ctx => {
              const ci = d.c[ctx.p0DataIndex];
              return ci === 'm' ? undefined : ci === 'e' ? [5, 3] : [2, 4];
            },
          },
    };
  });

  paint('pp', 'ppChart', {
    type: 'line',
    data: { labels: model.CTXL, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            title: i => 'context: ' + model.CTXL[i[0].dataIndex],
            label: c => `${c.dataset.label}: ${c.parsed.y ? Math.round(c.parsed.y) + ' t/s' : '—'}`,
          },
        },
      },
      scales: {
        x: axis('context length (tokens)'),
        y: axis('prefill t/s', {
          ticks: { color: TICKC, font: MONO_S, callback: v => (v >= 1000 ? v / 1000 + 'K' : v) },
        }),
      },
    },
  });
}

// === Decode rate ===
export function renderDecode(model, state) {
  const data = model.TG[state.arch];
  const sorted = model.PLAT.filter(p => data[p.id].v).sort((a, b) => data[b.id].v - data[a.id].v);

  paint('tg', 'tgChart', {
    type: 'bar',
    data: {
      labels: sorted.map(p => p.short),
      datasets: [
        {
          label: 'tg (short context)',
          data: sorted.map(p => data[p.id].v),
          backgroundColor: sorted.map(p => platColor(model, p.id, 0.85)),
          borderColor: sorted.map(p => p.color),
          borderWidth: 1.5,
          borderRadius: 3,
        },
        {
          label: 'tg @32K+ (measured)',
          data: sorted.map(p => data[p.id].v32),
          backgroundColor: sorted.map(p => platColor(model, p.id, 0.35)),
          borderColor: sorted.map(p => p.color),
          borderWidth: 1.5,
          borderDash: [3, 3],
          borderRadius: 3,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#8898a9',
            font: MONO,
            generateLabels: chart =>
              chart.data.datasets.map((d, i) => ({
                text: d.label,
                fillStyle: i === 0 ? '#5fd97a' : 'rgba(95,217,122,.4)',
                strokeStyle: 'transparent',
                index: i,
                hidden: !chart.isDatasetVisible(i),
              })),
          },
        },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            label: c => (c.parsed.x ? `${c.dataset.label}: ${c.parsed.x.toFixed(1)} t/s` : '—'),
          },
        },
      },
      scales: {
        x: axis('decode t/s (single stream)'),
        y: { grid: { color: 'rgba(0,0,0,0)' }, ticks: { color: TICKC, font: MONO } },
      },
    },
  });
}

// === Cold-start wall-clock: TTFT + generation, stacked ===
// What a session START, a cache eviction, or a mid-prefix edit costs -- see
// renderSteadyState below for what an already-warm turn costs instead.
export function renderWallClock(model, state) {
  const sorted = computeWC(model, state.arch)
    .filter(x => x.total !== null)
    .sort((a, b) => a.total - b.total);
  const platMap = Object.fromEntries(model.PLAT.map(p => [p.id, p]));
  const labels = sorted.map(x => platMap[x.id].short);
  const borders = sorted.map(x => platMap[x.id].color);

  paint('wc', 'wcChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'TTFT (16K cold prefill)',
          data: sorted.map(x => x.ttft),
          backgroundColor: sorted.map(x => platColor(model, x.id, 0.9)),
          borderColor: borders,
          borderWidth: 1.2,
          borderRadius: 2,
          stack: 's',
        },
        {
          label: 'Generation (2K tokens)',
          data: sorted.map(x => x.gen),
          backgroundColor: sorted.map(x => platColor(model, x.id, 0.4)),
          borderColor: borders,
          borderWidth: 1.2,
          borderRadius: 2,
          borderDash: [2, 2],
          stack: 's',
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#8898a9',
            font: MONO,
            generateLabels: chart =>
              chart.data.datasets.map((d, i) => ({
                text: d.label,
                fillStyle: i === 0 ? 'rgba(95,217,122,.7)' : 'rgba(95,217,122,.3)',
                strokeStyle: 'transparent',
                index: i,
                hidden: !chart.isDatasetVisible(i),
              })),
          },
        },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            title: i => `${labels[i[0].dataIndex]} · total: ${fmtT(sorted[i[0].dataIndex].total)}`,
            label: c => `${c.dataset.label}: ${fmtT(c.parsed.x)}${c.datasetIndex === 0 ? ' (TTFT)' : ' (gen)'}`,
          },
        },
      },
      scales: {
        x: axis('wall-clock seconds (TTFT + generation, stacked)', {
          stacked: true,
          ticks: { color: TICKC, font: MONO_S, callback: v => (v < 60 ? v + 's' : (v / 60).toFixed(1) + 'm') },
        }),
        y: { stacked: true, grid: { color: 'rgba(0,0,0,0)' }, ticks: { color: TICKC, font: MONO } },
      },
    },
  });
}

// === Steady-state turn: append + generate, once the session is already warm ===
// Same 16K-deep / 2K-token turn size as the cold chart above, so the two are
// directly comparable -- the only thing that changes is whether the prompt
// is prefilled from empty or appended onto an already-hot KV cache. The gap
// between the two IS the caching story: near-zero for linear/hybrid attention,
// still substantial for full attention, because the marginal cost of new
// tokens keeps scaling with how deep the session already is.
export function renderSteadyState(model, state) {
  const sorted = computeSteadyState(model, state.arch)
    .filter(x => x.total !== null)
    .sort((a, b) => a.total - b.total);
  const platMap = Object.fromEntries(model.PLAT.map(p => [p.id, p]));
  const labels = sorted.map(x => platMap[x.id].short);
  const borders = sorted.map(x => platMap[x.id].color);

  paint('ss', 'ssChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Append ${STEADY_STATE_TOKENS / 1024}K (warm, marginal rate)`,
          data: sorted.map(x => x.ttft),
          backgroundColor: sorted.map(x => platColor(model, x.id, 0.9)),
          borderColor: borders,
          borderWidth: 1.2,
          borderRadius: 2,
          stack: 's',
        },
        {
          label: `Generation (${STEADY_STATE_TOKENS / 1024}K tokens)`,
          data: sorted.map(x => x.gen),
          backgroundColor: sorted.map(x => platColor(model, x.id, 0.4)),
          borderColor: borders,
          borderWidth: 1.2,
          borderRadius: 2,
          borderDash: [2, 2],
          stack: 's',
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#8898a9',
            font: MONO,
            generateLabels: chart =>
              chart.data.datasets.map((d, i) => ({
                text: d.label,
                fillStyle: i === 0 ? 'rgba(91,155,213,.7)' : 'rgba(91,155,213,.3)',
                strokeStyle: 'transparent',
                index: i,
                hidden: !chart.isDatasetVisible(i),
              })),
          },
        },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            title: i => `${labels[i[0].dataIndex]} · total: ${fmtT(sorted[i[0].dataIndex].total)}`,
            label: c => `${c.dataset.label}: ${fmtT(c.parsed.x)}${c.datasetIndex === 0 ? ' (append)' : ' (gen)'}`,
          },
        },
      },
      scales: {
        x: axis('wall-clock seconds (append + generation, stacked)', {
          stacked: true,
          ticks: { color: TICKC, font: MONO_S, callback: v => (v < 60 ? v + 's' : (v / 60).toFixed(1) + 'm') },
        }),
        y: { stacked: true, grid: { color: 'rgba(0,0,0,0)' }, ticks: { color: TICKC, font: MONO } },
      },
    },
  });
}

// === Build value: efficiency under load, or standing idle cost ===
export function renderValue(model, state, arch) {
  const isLoad = state.valPower === 'load';
  const rows = isLoad
    ? rankedBuilds(model, arch, (b, v) => v / b.loadW)
    : model.BUILDS.filter(b => buildDecode(model, b, arch).v)
        .map(b => ({ b, m: b.idleW }))
        .sort((x, y) => x.m - y.m);

  paint(
    'val',
    'valChart',
    {
      type: 'bar',
      data: {
        labels: rows.map(r => r.b.short),
        datasets: [
          {
            label: isLoad ? 'tok/s per W' : 'idle W',
            data: rows.map(r => r.m),
            backgroundColor: rows.map(r => hexA(r.b.color, 0.85)),
            borderColor: rows.map(r => r.b.color),
            borderWidth: 1.5,
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...TOOLTIP,
            callbacks: {
              label: c => {
                const r = rows[c.dataIndex];
                return isLoad
                  ? `${c.parsed.x.toFixed(3)} tok/s per W (load)`
                  : `${r.b.idleW} W idle · ~$${Math.round(idleYr(model, r.b.idleW))}/yr if left on`;
              },
            },
          },
        },
        scales: {
          x: axis(
            isLoad
              ? 'tokens/sec per watt under load — higher better'
              : 'idle watts — lower better'
          ),
          y: { grid: { color: 'rgba(0,0,0,0)' }, ticks: { color: TICKC, font: MONO } },
        },
      },
    },
    true
  );
}

// === Compute throughput by precision: one precision at a time, vendor-colored ===
// A single axis across every precision would put ~1 TFLOPS FP64 parts next to
// ~10,000 TOPS INT4 parts, so this shows one precision per view rather than
// grouping them all -- the precision toggle in the tbar is the "sort" the
// user picks, this chart is what results. Units with nothing recorded for the
// selected precision are absent from the chart entirely, never a zero bar.
export function renderPrecision(model, state) {
  if (!state.precision) return;
  const rows = precisionRows(model.UNITS, state.precision).filter(r => !state.precHidden.has(r.u.vendor ?? 'Other'));
  const unitLabel = precisionUnitLabel(state.precision);
  const colors = rows.map(r => vendorColor(r.u.vendor));

  // Chart.js does not grow a fixed-height container on its own, and this list
  // can run much longer than the 9-platform charts elsewhere on the page.
  const canvas = document.getElementById('precChart');
  canvas.parentElement.style.height = `${Math.max(340, rows.length * 30 + 40)}px`;

  paint(
    'prec',
    'precChart',
    {
      type: 'bar',
      data: {
        labels: rows.map(r => r.u.label),
        datasets: [
          {
            label: 'dense',
            data: rows.map(r => r.dense),
            backgroundColor: colors.map(c => hexA(c, 0.85)),
            borderColor: colors,
            borderWidth: 1.5,
            borderRadius: 3,
          },
          {
            label: '2:4 structured sparsity',
            data: rows.map(r => r.sparse),
            backgroundColor: colors.map(c => hexA(c, 0.35)),
            borderColor: colors,
            borderWidth: 1.5,
            borderDash: [3, 3],
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#8898a9',
              font: MONO,
              generateLabels: chart =>
                chart.data.datasets.map((d, i) => ({
                  text: d.label,
                  fillStyle: i === 0 ? 'rgba(118,185,0,.8)' : 'rgba(118,185,0,.35)',
                  strokeStyle: 'transparent',
                  index: i,
                  hidden: !chart.isDatasetVisible(i),
                })),
            },
          },
          tooltip: {
            ...TOOLTIP,
            callbacks: {
              label: c => (c.parsed.x ? `${c.dataset.label}: ${c.parsed.x.toLocaleString()} ${unitLabel}` : '—'),
            },
          },
        },
        scales: {
          x: axis(`${state.precision.toUpperCase()} throughput (10¹² ops/sec, ${unitLabel})`, {
            ticks: { color: TICKC, font: MONO_S, callback: v => (v >= 1000 ? v / 1000 + 'K' : v) },
          }),
          y: { grid: { color: 'rgba(0,0,0,0)' }, ticks: { color: TICKC, font: MONO_S } },
        },
      },
    },
    true
  );
}
