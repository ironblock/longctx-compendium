// DOM rendering for the roofline (theoretical-maximum) section: pick a
// model and a storage quant, see what every catalog platform's OWN rated
// compute throughput and memory bandwidth say it should be able to do --
// before any benchmark, and independent of what this page has actually
// measured for it.

import { theoreticalPrefillDecode, platformComputeRateForQuant, BPW_TABLE } from './roofline.js';
import { MODELS } from './models.js';

const el = id => document.getElementById(id);

/**
 * quant -> which dequant-map.js quantFamily it belongs to (null for an
 * unquantized baseline, whose precision needs no per-architecture lookup at
 * all). See docs/roofline-dequant-paths.md for what each family was
 * actually found to execute at, per architecture -- platformComputeRateForQuant
 * resolves the real per-unit precision from that grounded map, falling back
 * to the documented-safe fp16 floor only where the research found no answer.
 */
const QUANT_INFO = {
  fp16: { quantFamily: null, basePrecision: 'fp16' },
  q8_0: { quantFamily: 'legacy8bit' },
  q6_k: { quantFamily: 'kquant' },
  q5_k: { quantFamily: 'kquant' },
  q4_k_m: { quantFamily: 'kquant' },
  mxfp4: { quantFamily: 'mxfp4' },
  nvfp4: { quantFamily: 'nvfp4' },
  fp8: {
    quantFamily: null,
    basePrecision: 'fp8',
    caveat: 'Not a GGUF quant type -- ggml has no GGML_TYPE for fp8 storage (confirmed by source read, see docs/roofline-dequant-paths.md). Models a hypothetical native-fp8 checkpoint instead (e.g. the vLLM/safetensors fp8 builds this page already cites for PRO 6000).',
  },
};

// A curated subset of MODELS -- one representative per archetype this page
// already has, plus the two headline MoE sizes -- rather than every entry,
// so the dropdown stays a comparison tool instead of a wall of buttons.
// Deliberately named model, not archetype: FACTCHECK-2026-08-08.md found the
// existing 'moe'/'dense' archetypes each blend more than one real model, and
// this section exists partly to make that visible rather than repeat it.
export const ROOFLINE_MODELS = ['qwen3_30b_a3b', 'qwen36_35b_a3b', 'qwen3_32b', 'qwen36_27b', 'gpt_oss_120b'];
export const ROOFLINE_QUANTS = ['fp16', 'q8_0', 'q6_k', 'q5_k', 'q4_k_m', 'mxfp4', 'nvfp4', 'fp8'];

export function renderRooflineToggles(state) {
  el('roofModelTg').innerHTML = ROOFLINE_MODELS.map(id => {
    const m = MODELS[id];
    return `<button data-rm="${id}"${id === state.roofModel ? ' class="on"' : ''}>${m.label}</button>`;
  }).join('');
  el('roofQuantTg').innerHTML = ROOFLINE_QUANTS.map(q =>
    `<button data-rq="${q}"${q === state.roofQuant ? ' class="on"' : ''}>${q.toUpperCase()}</button>`
  ).join('');
}

const dash = '<td class="c-n"><span class="num">—</span></td>';
const boundBadge = b =>
  b ? `<span style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em">${b}-bound</span>` : '';

/** One unit's resolved precision, marked ungrounded (dim, "?") when the
 *  dequant-path research had no finding for this quant/architecture combo. */
const basisTag = r =>
  r.grounded
    ? `${r.precision.toUpperCase()}`
    : `<span style="color:var(--u)" title="${r.note.replace(/"/g, '&quot;')}">${r.precision.toUpperCase()}?</span>`;

export function renderRooflineTable(model, state) {
  const tb = document.querySelector('#roofTable tbody');
  tb.innerHTML = '';

  const modelSpec = MODELS[state.roofModel];
  const bpwEntry = BPW_TABLE[state.roofQuant];
  const quantInfo = QUANT_INFO[state.roofQuant];
  const unitById = Object.fromEntries(model.UNITS.map(u => [u.id, u]));

  const groups = [...new Set(model.PLAT.map(p => p.group))];
  for (const g of groups) {
    const gr = document.createElement('tr');
    gr.innerHTML = `<td colspan="6" class="grp lbl" style="padding:6px 10px">${g}</td>`;
    tb.appendChild(gr);

    for (const p of model.PLAT.filter(x => x.group === g)) {
      const platform = model.raw.platforms.find(x => x.id === p.id);
      const rates = platformComputeRateForQuant(platform, unitById, quantInfo.quantFamily, quantInfo.basePrecision);
      const tr = document.createElement('tr');
      const basis = rates.perUnitResolution.length ? basisTag(rates.perUnitResolution[0]) : '?';

      let cells;
      if (!rates.opsPerSec || !rates.bandwidthGBs) {
        cells = `${dash}${dash}` + `<td class="lbl"><span style="font-size:11px;color:var(--dim)">no ${basis} rating in catalog</span></td>`;
      } else {
        const { prefill, decode } = theoreticalPrefillDecode({
          opsPerSec: rates.opsPerSec,
          bandwidthGBs: rates.bandwidthGBs,
          activeParams: modelSpec.activeParams,
          bytesPerParam: bpwEntry.bpw / 8,
        });
        const cell = r =>
          r.tokensPerSec == null
            ? dash
            : `<td class="num">${Math.round(r.tokensPerSec).toLocaleString()}<br>${boundBadge(r.bound)}</td>`;
        cells = cell(prefill) + cell(decode) +
          `<td class="lbl"><span style="font-size:11px;color:var(--dim)">${basis} @ ${bpwEntry.bpw} bpw · ${(modelSpec.activeParams / 1e9).toFixed(1)}B active</span></td>`;
      }

      tr.innerHTML =
        `<td class="lbl"><span style="font-family:var(--mono);font-size:12px;color:${p.color};font-weight:700">${p.short}</span>` +
        `<span style="display:block;font-size:10px;color:var(--dim)">${p.label}</span></td>` +
        cells;
      tb.appendChild(tr);
    }
  }

  const caveat = quantInfo.caveat ? ` ⚠ ${quantInfo.caveat}` : '';
  el('roofCap').textContent =
    `Theoretical maximum for ${modelSpec.label} (${(modelSpec.activeParams / 1e9).toFixed(1)}B active` +
    (modelSpec.activeParams !== modelSpec.totalParams ? ` of ${(modelSpec.totalParams / 1e9).toFixed(0)}B total, MoE` : ', dense') +
    `) at ${state.roofQuant.toUpperCase()} · assumes perfect (100%) utilization of each unit's own rated compute throughput and bandwidth, at the precision this quant is actually confirmed to execute at on that unit's own architecture (see docs/roofline-dequant-paths.md) — a dimmed "?" means no grounded finding for that combination, fp16-floor assumed.${caveat}`;
}
