// Entry point: loads the data, wires the toggles, and owns the small amount of
// view state. Everything below this file is a pure function of (model, state).

import { load } from './data.js';
import { archOf, precisionRows, precisionUnitLabel } from './derive.js';
import { renderPrefill, renderDecode, renderWallClock, renderSteadyState, renderValue, renderPrecision } from './charts.js';
import {
  renderLegend,
  renderPrefillTable,
  renderDecodeTable,
  renderValueTable,
  renderSpecTable,
  renderPrecisionToggle,
  renderVendorLegend,
} from './tables.js';
import { prefillVerdict, steadyStateVerdict, valueVerdict, captionFor, valueCaption } from './verdicts.js';
import { renderRooflineToggles, renderRooflineTable } from './roofline-ui.js';

const state = {
  view: 'pp',
  arch: 'moe',
  hidden: new Set(),
  valModel: 'tg120',
  valPower: 'load',
  precision: null,
  precHidden: new Set(),
  // Q4_K_M is the single most-cited quant across this page's own perf
  // notes, and the hybrid-MoE model is what most of the multi-point-
  // measured platforms (B70, R9700, Strix Halo) actually ran, so the
  // section opens on the comparison closest to what's already on the page.
  roofModel: 'qwen36_35b_a3b',
  roofQuant: 'q4_k_m',
};

const el = id => document.getElementById(id);

/** A static site has no server to report to, so failures have to render. */
function fail(err) {
  console.error(err);
  const box = el('loadError');
  box.textContent = `Could not render the compendium — ${err.message}`;
  box.classList.remove('hidden');
  document.querySelectorAll('.chartbox, .tscroll').forEach(n => n.classList.add('hidden'));
}

/**
 * The honesty banner counts every datapoint by confidence code, so the tallies
 * cannot drift away from the data the way hand-written counts did.
 */
function renderConfidenceTally(model) {
  const tally = {};
  for (const arch of Object.keys(model.PP)) {
    for (const id of Object.keys(model.PP[arch])) {
      for (const c of model.PP[arch][id].c) tally[c] = (tally[c] ?? 0) + 1;
      const tg = model.TG[arch][id];
      if (tg.c && tg.c !== 'n') tally[tg.c] = (tally[tg.c] ?? 0) + 1;
      if (tg.v32 != null) tally.m = (tally.m ?? 0) + 1;
    }
  }
  const measured = (tally.m ?? 0) + (tally['m~'] ?? 0);
  el('cMeasured').textContent = measured;
  el('cExtrap').textContent = tally.e ?? 0;
  el('cModeled').textContent = tally.i ?? 0;
  el('cArch').textContent = model.ARCHETYPES.length;
}

function renderMain(model) {
  el('ppCap').textContent = captionFor(model, state.arch, 'pp');
  el('tgCap').textContent = captionFor(model, state.arch, 'tg');
  el('wcCap').textContent = captionFor(model, state.arch, 'wc');
  el('ssCap').textContent = captionFor(model, state.arch, 'ss');
  // The verdict box is the bottom-line synthesis regardless of which chart is
  // visible, but "the bottom line" means something different once you're
  // looking at steady-state turns instead of a cold-start event.
  el('verdict').innerHTML =
    state.view === 'ss' ? steadyStateVerdict(model, state.arch) : prefillVerdict(model, state.arch);

  if (state.view === 'pp') renderPrefill(model, state);
  else if (state.view === 'tg') renderDecode(model, state);
  else if (state.view === 'ss') renderSteadyState(model, state);
  else renderWallClock(model, state);
}

function renderValueSection(model) {
  const arch = archOf(state.valModel);
  renderValueTable(model, state);
  renderValue(model, state, arch);
  const cap = valueCaption(state.valModel, state.valPower);
  el('valCap').textContent = cap.main;
  el('valCap2').textContent = cap.sub;
  el('valVerdict').innerHTML = valueVerdict(state.valModel, state.valPower);
}

function renderRooflineSection(model) {
  renderRooflineToggles(state);
  renderRooflineTable(model, state);
}

function renderPrecisionSection(model) {
  renderPrecisionToggle(model, state); // may update state.precision
  renderVendorLegend(model, state, () => renderPrecision(model, state));
  renderPrecision(model, state);
  if (state.precision) {
    const n = precisionRows(model.UNITS, state.precision).length;
    el('precCap').textContent =
      `${state.precision.toUpperCase()} throughput (${precisionUnitLabel(state.precision)}) · ${n} of ${model.UNITS.length} catalog units have data`;
  } else {
    el('precCap').textContent = 'No compute.values recorded on any unit yet.';
  }
}

/** Radio-style button groups: exactly one `on` at a time. */
function wireToggle(groupId, attr, onPick) {
  const buttons = [...document.querySelectorAll(`#${groupId} button`)];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      buttons.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset[attr]);
    });
  }
}

function setView(v) {
  state.view = v;
  el('ppBox').classList.toggle('hidden', v !== 'pp');
  el('tgBox').classList.toggle('hidden', v !== 'tg');
  el('wcBox').classList.toggle('hidden', v !== 'wc');
  el('ssBox').classList.toggle('hidden', v !== 'ss');
}

try {
  const model = await load();

  renderConfidenceTally(model);
  renderLegend(model, state, () => {
    if (state.view === 'pp') renderPrefill(model, state);
  });
  renderPrefillTable(model);
  renderDecodeTable(model);
  renderSpecTable(model);
  renderPrecisionSection(model);
  renderRooflineSection(model);
  renderValueSection(model);
  renderMain(model);

  wireToggle('viewTg', 'v', v => {
    setView(v);
    renderMain(model);
  });
  wireToggle('archTg', 'a', a => {
    state.arch = a;
    renderMain(model);
  });
  wireToggle('valModelTg', 'vm', vm => {
    state.valModel = vm;
    renderValueSection(model);
  });
  wireToggle('valPowerTg', 'vp', vp => {
    state.valPower = vp;
    renderValueSection(model);
  });
  // The precision toggle rebuilds its own buttons every render (the set of
  // precisions is data-driven), so binding is delegated to the container
  // rather than rebound per-button like the fixed toggles above.
  el('precTg').addEventListener('click', e => {
    const prec = e.target.dataset.prec;
    if (!prec) return;
    state.precision = prec;
    renderPrecisionSection(model);
  });
  wireToggle('roofModelTg', 'rm', rm => {
    state.roofModel = rm;
    renderRooflineTable(model, state);
  });
  wireToggle('roofQuantTg', 'rq', rq => {
    state.roofQuant = rq;
    renderRooflineTable(model, state);
  });
} catch (err) {
  fail(err);
}
