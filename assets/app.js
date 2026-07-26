// Entry point: loads the data, wires the toggles, and owns the small amount of
// view state. Everything below this file is a pure function of (model, state).

import { load } from './data.js';
import { archOf } from './derive.js';
import { renderPrefill, renderDecode, renderWallClock, renderValue } from './charts.js';
import {
  renderLegend,
  renderPrefillTable,
  renderDecodeTable,
  renderValueTable,
  renderSpecTable,
} from './tables.js';
import { prefillVerdict, valueVerdict, captionFor, valueCaption } from './verdicts.js';

const state = {
  view: 'pp',
  arch: 'moe',
  hidden: new Set(),
  valModel: 'tg120',
  valPower: 'load',
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
  el('verdict').innerHTML = prefillVerdict(model, state.arch);

  if (state.view === 'pp') renderPrefill(model, state);
  else if (state.view === 'tg') renderDecode(model, state);
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
} catch (err) {
  fail(err);
}
