// Range sliders for the numeric controls. Two kinds:
//
//   rangeSlider -- two handles (a minimum and a maximum) with a number box at
//                  each end, for filters. A handle at its end of the scale
//                  means "no bound", and its box is left empty.
//   slider      -- one handle with a readout, for a single setting.
//
// Both are built once and then only synced, so a re-render never tears down
// the input under a pointer mid-drag. Scales can be logarithmic, which is what
// bandwidth, price, memory and context depth all want: the interesting
// differences are ratios, not sums.
//
// A handle keeps its raw position while it moves and only the value it
// reports is rounded. Writing the rounded value back to the handle would pull
// it back to where it started on every small step, so arrow keys and slow
// drags near a rounding boundary would do nothing.

// 200 positions: an arrow key moves about half a percent of the scale.
const STEPS = 200;

function scale({ min, max, log }) {
  const a = log ? Math.log(min) : min;
  const b = log ? Math.log(max) : max;
  return {
    toPos: v => Math.round((((log ? Math.log(v) : v) - a) / (b - a)) * STEPS),
    toVal: p => {
      const x = a + (p / STEPS) * (b - a);
      return log ? Math.exp(x) : x;
    },
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (p, span = STEPS) => `${(p / span) * 100}%`;
const same = (x, y) => (x == null && y == null) || x === y;

/**
 * Two-handle range. `set([lo, hi])` syncs it from state, with null for an open
 * end; `snap` rounds a dragged value to something worth typing;
 * `onChange([lo, hi], live)` fires on every movement (live while dragging).
 */
export function rangeSlider(host, { min, max, log = false, snap = v => v, unit = '', label, onChange }) {
  const s = scale({ min, max, log });
  const name = `${label}${unit ? `, ${unit}` : ''}`;
  host.classList.add('range');
  host.innerHTML =
    `<div class="slider"><div class="track"><div class="fill"></div></div>` +
    `<input type="range" class="lo" min="0" max="${STEPS}" step="1" aria-label="Minimum ${label}">` +
    `<input type="range" class="hi" min="0" max="${STEPS}" step="1" aria-label="Maximum ${label}"></div>` +
    `<div class="range-vals">` +
    `<input type="number" class="lo-num" min="${min}" max="${max}" step="any" inputmode="decimal" placeholder="${min.toLocaleString()}" aria-label="Minimum ${name}">` +
    `<span>to</span>` +
    `<input type="number" class="hi-num" min="${min}" max="${max}" step="any" inputmode="decimal" placeholder="${max.toLocaleString()}" aria-label="Maximum ${name}">` +
    `<span class="unit">${unit}</span></div>`;
  const [lo, hi] = host.querySelectorAll('input[type=range]');
  const [loNum, hiNum] = host.querySelectorAll('input[type=number]');
  const box = host.querySelector('.slider');
  let current = [null, null];
  let placed = false;

  function place(pl, ph) {
    lo.value = pl;
    hi.value = ph;
    fill(pl, ph);
    placed = true;
  }
  function fill(pl, ph) {
    box.style.setProperty('--lo', pct(pl));
    box.style.setProperty('--hi', pct(ph));
    // When both handles sit at the top, the lower one must stay reachable.
    lo.style.zIndex = pl > STEPS / 2 ? 3 : 2;
  }
  // Boxes are only written once a change is committed, never mid-typing, so
  // they can always show the state.
  // One decimal is plenty to read; the filter itself keeps whatever was typed.
  const shown = v => (v == null ? '' : String(Math.round(v * 10) / 10));
  function boxes() {
    loNum.value = shown(current[0]);
    hiNum.value = shown(current[1]);
  }
  const open = ([a, b]) => [a != null && a <= min ? null : a, b != null && b >= max ? null : b];

  function fromHandle(which, live) {
    let pl = Number(lo.value);
    let ph = Number(hi.value);
    if (pl > ph) {
      if (which === 'lo') lo.value = pl = ph;
      else hi.value = ph = pl;
    }
    current = open([pl <= 0 ? null : snap(s.toVal(pl)), ph >= STEPS ? null : snap(s.toVal(ph))]);
    fill(pl, ph);
    boxes();
    onChange(current, live);
  }

  function fromBox() {
    // A box still showing the rounded form of the current bound keeps the exact
    // bound (1 TiB/s typed as 1099.511627776 stays that, not 1099.5).
    const read = (el, i) =>
      el.value === shown(current[i]) ? current[i] : el.value === '' || !Number.isFinite(Number(el.value)) ? null : clamp(Number(el.value), min, max);
    let [a, b] = open([read(loNum, 0), read(hiNum, 1)]);
    if (a != null && b != null && a > b) [a, b] = [b, a];
    current = [a, b];
    place(a == null ? 0 : s.toPos(a), b == null ? STEPS : s.toPos(b));
    boxes();
    onChange(current, false);
  }

  lo.addEventListener('input', () => fromHandle('lo', true));
  hi.addEventListener('input', () => fromHandle('hi', true));
  lo.addEventListener('change', () => fromHandle('lo', false));
  hi.addEventListener('change', () => fromHandle('hi', false));
  loNum.addEventListener('change', fromBox);
  hiNum.addEventListener('change', fromBox);

  return {
    set([a = null, b = null]) {
      // A value this slider just reported is already where its handle is.
      if (placed && same(a, current[0]) && same(b, current[1])) return boxes();
      current = [a, b];
      place(a == null ? 0 : clamp(s.toPos(a), 0, STEPS), b == null ? STEPS : clamp(s.toPos(b), 0, STEPS));
      boxes();
    },
  };
}

/**
 * One handle. `format(v)` writes the readout; `set(v, disabled)` greys it out
 * while another control (a "fewest that fit" box) is deciding the value.
 * `step` gives a linear scale in real units (card counts); without it the
 * scale has STEPS positions, logarithmic when `log` is set.
 */
export function slider(host, { min, max, log = false, step, snap = v => v, format = String, disabledText, label, onChange }) {
  const s = step == null ? scale({ min, max, log }) : null;
  host.classList.add('single');
  host.innerHTML =
    `<div class="slider"><div class="track"><div class="fill"></div></div>` +
    `<input type="range" ${s ? `min="0" max="${STEPS}" step="1"` : `min="${min}" max="${max}" step="${step}"`} aria-label="${label}"></div>` +
    `<output class="readout" aria-live="polite"></output>`;
  const input = host.querySelector('input');
  const out = host.querySelector('output');
  const box = host.querySelector('.slider');
  const toPos = v => (s ? clamp(s.toPos(v), 0, STEPS) : v);
  const toVal = p => (s ? snap(s.toVal(Number(p))) : Number(p));
  const fill = p => box.style.setProperty('--hi', s ? pct(p) : pct(p - min, max - min));
  let current = null;

  function show(v, disabled) {
    input.disabled = !!disabled;
    host.classList.toggle('disabled', !!disabled);
    out.textContent = disabled && disabledText ? disabledText : format(v);
  }
  const fire = live => {
    current = toVal(input.value);
    fill(Number(input.value));
    show(current, input.disabled);
    onChange(current, live);
  };
  input.addEventListener('input', () => fire(true));
  input.addEventListener('change', () => fire(false));

  return {
    set(v, disabled) {
      // A value this slider just reported is already where its handle is.
      if (v !== current) {
        current = v;
        input.value = toPos(v);
        fill(toPos(v));
      }
      show(v, disabled);
    },
  };
}
