// Chart.js configuration for the two charts. Colours are read from CSS custom
// properties so the palette lives in one place (assets/styles.css), and every
// value a chart shows is also in a table beside it.

/* global Chart */

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const charts = {};
// Canvas text gets no CSS fallback, so name one; and keep chart text in the page's faces.
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = '"IBM Plex Sans", system-ui, sans-serif';
  Chart.defaults.color = css('--muted');
}

/**
 * Create a chart once, then update it in place: rebuilding a chart on every
 * slider movement costs a canvas, a layout pass and an animation frame each.
 */
function mount(id, config) {
  const c = charts[id];
  if (c && c.config.type === config.type) {
    c.data = config.data;
    c.options = config.options;
    c.update('none');
    return c;
  }
  c?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
  return charts[id];
}

const fmtNum = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K` : String(Math.round(v * 10) / 10));
/** Context depths are powers of two: 4096 is "4K", 262144 is "256K", 1048576 is "1M". */
const fmtTokens = v => (v >= 1048576 ? `${v / 1048576}M` : v >= 1024 ? `${Math.round(v / 1024)}K` : String(v));

function axisBase() {
  return {
    grid: { color: css('--line'), drawTicks: false },
    border: { color: css('--line') },
    ticks: { color: css('--muted'), font: { family: '"Space Mono", ui-monospace, monospace', size: 10 }, padding: 6 },
    title: { display: true, color: css('--muted'), font: { family: '"Space Mono", ui-monospace, monospace', size: 10.5 } },
  };
}

function tooltipBase() {
  return {
    backgroundColor: '#0b1019',
    borderColor: css('--line'),
    borderWidth: 1,
    titleColor: css('--text'),
    bodyColor: css('--muted'),
    titleFont: { family: 'IBM Plex Sans', size: 12, weight: '600' },
    bodyFont: { family: 'Space Mono', size: 11 },
    padding: 10,
    displayColors: false,
  };
}

/**
 * Direct labels for the highlighted points only, placed greedily so no two
 * collide: right of the point, then left, above, below; a label with nowhere
 * to go is dropped, and the tooltip and table still carry it.
 */
const pointLabels = {
  id: 'pointLabels',
  afterDatasetsDraw(chart) {
    const ds = chart.data.datasets.findIndex(d => d.labelPoints);
    if (ds < 0) return;
    const { ctx, chartArea: a } = chart;
    const meta = chart.getDatasetMeta(ds);
    ctx.save();
    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillStyle = css('--text');
    ctx.textBaseline = 'middle';
    const placed = [];
    const hits = (r) => placed.some(p => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    const pts = meta.data.map((el, i) => ({ el, d: chart.data.datasets[ds].data[i] })).sort((p, q) => q.d.y - p.d.y);
    // markers themselves are obstacles too
    for (const { el } of pts) placed.push({ x: el.x - 5, y: el.y - 5, w: 10, h: 10 });
    for (const { el, d } of pts) {
      const text = d.short ?? d.label;
      const w = ctx.measureText(text).width + 4;
      const h = 14;
      const tries = [
        { x: el.x + 8, y: el.y - h / 2 },
        { x: el.x - 8 - w, y: el.y - h / 2 },
        { x: el.x - w / 2, y: el.y - 10 - h },
        { x: el.x - w / 2, y: el.y + 10 },
      ];
      const spot = tries.find(r => r.x >= a.left && r.x + w <= a.right && r.y >= a.top && r.y + h <= a.bottom && !hits({ ...r, w, h }));
      if (!spot) continue;
      placed.push({ ...spot, w, h });
      ctx.fillText(text, spot.x + 2, spot.y + h / 2);
    }
    ctx.restore();
  },
};

/**
 * Bandwidth (what decode is bound by) against dense matrix throughput at one
 * precision (what prefill is bound by), one point per unit. Emphasis rather
 * than identity: units matching the hardware filter are the accent colour and
 * labelled, everything else is a muted point that only the tooltip names.
 */
export function renderScatter(units, matchIds, precision) {
  const point = u => ({
    x: u.memoryBandwidthGBs,
    y: u.compute.values[precision],
    label: u.label,
    short: u.short ?? u.label.replace(/\s*\d+GB$/, ''),
    arch: u.archLabel,
    mem: u.memoryGB,
    vendor: u.vendor ?? 'Other',
    unofficial: !!u.compute.unofficial?.includes(precision),
  });
  const plotted = units.filter(u => u.memoryBandwidthGBs && u.compute?.values?.[precision] != null);
  // Lowest first, so a point drawn over another is the higher one, which is
  // also the one pointLabels names: a label never sits on someone else's colour.
  const byY = (a, b) => a.y - b.y;
  const on = plotted.filter(u => matchIds.has(u.id)).map(point).sort(byY);
  const off = plotted.filter(u => !matchIds.has(u.id)).map(point).sort(byY);
  const unit = precision.startsWith('int') ? 'TOPS' : 'TFLOPS';

  mount('scatterChart', {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Other units',
          data: off,
          // Colour follows the vendor whether or not the point matches; matching is solid and labelled.
          backgroundColor: c => fade(vendorColor(c.raw?.vendor), 0.35),
          borderColor: css('--panel'),
          borderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointHitRadius: 12,
        },
        {
          label: 'Matches the filter',
          data: on,
          labelPoints: true,
          backgroundColor: c => vendorColor(c.raw?.vendor),
          borderColor: css('--panel'),
          borderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          pointHitRadius: 12,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 8, top: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: {
            title: items => items[0].raw.label,
            label: it => [
              `${it.raw.vendor} · ${it.raw.arch ?? 'generation not recorded'}`,
              `${it.raw.x.toLocaleString()} GB/s · ${it.raw.mem ?? '?'} GB`,
              `${it.raw.y.toLocaleString()} ${unit} dense ${precision.toUpperCase()}${it.raw.unofficial ? ' (unofficial)' : ''}`,
            ],
          },
        },
      },
      scales: {
        x: {
          type: 'logarithmic',
          ...axisBase(),
          title: { ...axisBase().title, text: 'memory bandwidth, GB/s (log) → bounds decode' },
          ticks: { ...axisBase().ticks, callback: v => ([250, 500, 1000, 2000, 4000, 8000].includes(v) ? fmtNum(v) : '') },
        },
        y: {
          type: 'logarithmic',
          ...axisBase(),
          title: { ...axisBase().title, text: `dense ${precision.toUpperCase()} ${unit} (log) → bounds prefill` },
          ticks: { ...axisBase().ticks, callback: v => (/^(1|2|5)/.test(String(v)) ? fmtNum(v) : '') },
        },
      },
    },
    plugins: [pointLabels],
  });
  return { plotted: plotted.length, on: on.length, unofficial: plotted.filter(u => u.compute.unofficial?.includes(precision)).length };
}

/** One colour per vendor, from the brand-colour tokens; anything unlisted gets the muted mark. */
export const VENDOR_TOKENS = { NVIDIA: '--v-nvidia', AMD: '--v-amd', Intel: '--v-intel', Apple: '--v-apple' };
export const vendorColor = v => css(VENDOR_TOKENS[v] ?? '--mute-mark');
/** A hex colour at an alpha, for marks that should recede. */
const fade = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export const LAYOUT_COLOR = () => ({ full: css('--s1'), sliding: css('--s2'), linear: css('--s3') });

/**
 * Share of the empty-context decode ceiling left at each depth, one line per
 * model, coloured by attention layout -- the property that decides the slope.
 * The selected model is drawn heavier and labelled at its end.
 */
export function renderDepth(series, selectedId) {
  const colors = LAYOUT_COLOR();
  const datasets = series
    .slice()
    .sort((a, b) => (a.id === selectedId) - (b.id === selectedId))
    .map(s => {
      const sel = s.id === selectedId;
      return {
        label: s.label,
        layout: s.layout,
        data: s.points,
        borderColor: sel ? colors[s.layout] : colors[s.layout] + '73',
        backgroundColor: colors[s.layout],
        borderWidth: sel ? 3 : 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
        tension: 0,
        selected: sel,
      };
    });
  mount('depthChart', {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false },
      layout: { padding: { right: 12 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipBase(),
          callbacks: {
            title: items => items[0].dataset.label,
            label: it => `${fmtTokens(it.raw.x)} tokens deep: ${Math.round(it.raw.y)}% of the empty-context ceiling`,
          },
        },
      },
      scales: {
        x: {
          type: 'logarithmic',
          min: 1024,
          ...axisBase(),
          title: { ...axisBase().title, text: 'context depth, tokens (log)' },
          ticks: { ...axisBase().ticks, callback: v => ([1024, 4096, 16384, 65536, 262144, 1048576].includes(v) ? fmtTokens(v) : '') },
          afterBuildTicks: axis => {
            axis.ticks = [1024, 4096, 16384, 65536, 262144, 1048576].filter(v => v >= axis.min && v <= axis.max).map(v => ({ value: v }));
          },
        },
        y: {
          min: 0,
          max: 100,
          ...axisBase(),
          title: { ...axisBase().title, text: '% of the empty-context decode ceiling' },
          ticks: { ...axisBase().ticks, stepSize: 25, callback: v => `${v}%` },
        },
      },
    },
    plugins: [
      {
        id: 'endLabel',
        afterDatasetsDraw(chart) {
          const i = chart.data.datasets.findIndex(d => d.selected);
          if (i < 0) return;
          const el = chart.getDatasetMeta(i).data.at(-1);
          if (!el) return;
          const { ctx } = chart;
          ctx.save();
          ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif';
          ctx.fillStyle = css('--text');
          const text = chart.data.datasets[i].label;
          const w = ctx.measureText(text).width;
          ctx.textBaseline = 'bottom';
          ctx.fillText(text, Math.min(el.x - w, chart.chartArea.right - w), el.y - 6);
          ctx.restore();
        },
      },
    ],
  });
}
