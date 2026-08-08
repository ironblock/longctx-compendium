// Editorial copy. Kept apart from the chart and table code because it is the
// part most often rewritten, and because prose interleaved with Chart.js config
// is miserable to review in a diff.

import { computeWC, computeSteadyState, fmtT } from './derive.js';

export function prefillVerdict(model, arch) {
  const wc = computeWC(model, arch);
  const ranked = wc.filter(x => x.total).sort((a, b) => a.total - b.total);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const plat = Object.fromEntries(model.PLAT.map(p => [p.id, p]));
  const name = id => `<b style="color:${plat[id].color}">${plat[id].short}</b>`;
  const totalFor = id => fmtT(wc.find(x => x.id === id)?.total);

  if (arch === 'moe') {
    return (
      `<b>MoE wall-clock.</b> Fastest: ${name(best.id)} at <b>${fmtT(best.total)}</b> ` +
      `(${fmtT(best.ttft)} prefill + ${fmtT(best.gen)} gen). Slowest modeled: ${name(worst.id)} ` +
      `at <b>${fmtT(worst.total)}</b>. MoE linear-attention keeps decode alive on bandwidth-starved ` +
      `boxes (DGX Spark ~37s, Strix Halo ~51s), but prefill at 16K is still 2–10× slower than the discrete GPUs.`
    );
  }
  if (arch === 'dense') {
    return (
      `<b>Dense wall-clock — the real indictment of bandwidth-bound boxes.</b> Dense 27–32B requires ` +
      `streaming ~18 GB of weights per token at ~10–27 t/s on unified-memory platforms. ` +
      `DGX Spark: <b style="color:var(--bad)">${totalFor('dgxspark')}</b>; ` +
      `Strix Halo: <b style="color:var(--bad)">${totalFor('strixhalo')}</b>. ` +
      `RTX PRO 6000: <b style="color:var(--ok)">${totalFor('pro6000')}</b>. ` +
      `The MoE archetype eliminates this penalty entirely — it is the correct model family for all three unified-memory platforms.`
    );
  }
  return (
    `<b>gpt-oss-120B (117B MoE, ~63GB) — the model that justifies 96–128GB.</b> Single 32GB cards ` +
    `(5090, R9700, 1× B70) can't load it and drop out here. Fastest wall-clock: ${name(best.id)} ` +
    `at <b>${fmtT(best.total)}</b>. Unified boxes stay usable on decode (Spark ~39, Strix ~40, Mac ~60 t/s) ` +
    `but pay for it in prefill. Build cost/power value is in the Bang-for-buck-per-watt section below.`
  );
}

/**
 * The steady-state counterpart to prefillVerdict above -- same per-arch
 * structure, but narrating what an active session actually pays turn to
 * turn rather than what a cold event costs. See computeSteadyState's own
 * comment in derive.js for why this isn't just "caching makes it free".
 */
export function steadyStateVerdict(model, arch) {
  const ss = computeSteadyState(model, arch);
  const cold = computeWC(model, arch);
  const ranked = ss.filter(x => x.total).sort((a, b) => a.total - b.total);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const plat = Object.fromEntries(model.PLAT.map(p => [p.id, p]));
  const name = id => `<b style="color:${plat[id].color}">${plat[id].short}</b>`;

  if (!best) {
    return (
      `<b>Steady-state turn.</b> No platform in this archetype has both a measured decode rate and a ` +
      `bracketing prefill segment to derive a marginal append rate from yet.`
    );
  }

  const compare = id => {
    const s = ss.find(x => x.id === id)?.total;
    const c = cold.find(x => x.id === id)?.total;
    if (!s || !c) return '';
    return ` (${fmtT(s)} steady-state vs ${fmtT(c)} cold — ${Math.round((1 - s / c) * 100)}% faster once warm)`;
  };

  if (arch === 'moe') {
    return (
      `<b>MoE steady-state — the number that actually governs an active session.</b> Fastest once warm: ` +
      `${name(best.id)} at <b>${fmtT(best.total)}</b>${compare(best.id)}. Linear/hybrid attention (Nemotron-class ` +
      `Mamba2, Gated DeltaNet) keeps this close to flat no matter how deep the session already is — full-attention ` +
      `platforms don't get that escape, and their steady-state number keeps climbing the longer the session runs, ` +
      `even though nothing is being re-prefilled.`
    );
  }
  if (arch === 'dense') {
    return (
      `<b>Dense steady-state.</b> Dense full-attention gets none of the architectural relief MoE/hybrid models ` +
      `get: every appended token still attends across the whole cache. Fastest once warm: ${name(best.id)} at ` +
      `<b>${fmtT(best.total)}</b>${compare(best.id)}. This is the honest floor for a long dense-model agentic ` +
      `session — caching buys you the past, not the climbing marginal cost of the present.`
    );
  }
  return (
    `<b>gpt-oss-120B steady-state.</b> Fastest once warm: ${name(best.id)} at <b>${fmtT(best.total)}</b>` +
    `${compare(best.id)}. Slowest: ${name(worst.id)} at <b>${fmtT(worst.total)}</b>. Compare against the ` +
    `Cold-start wall-clock view for the same platforms — the gap between the two is the entire caching story ` +
    `for this archetype.`
  );
}

export function valueVerdict(valModel, valPower) {
  const isLoad = valPower === 'load';
  if (valModel === 'tg120') {
    return isLoad
      ? `<b>120B · bang per watt (load).</b> Single modern cards win efficiency: <b style="color:#00e676">PRO 6000</b> (0.58) and <b style="color:#80cbc4">A100 80</b> (0.53) are ~4–5× better per watt than any 4-card rig (<b style="color:#4fc3f7">4× 3090</b> ≈ 0.12, <b style="color:#f3b54c">4× V100</b> ≈ 0.10). <b style="color:#ce93d8">M3 Ultra</b> (0.40) and <b style="color:#ffab40">Strix Halo</b> (0.29) punch above their price. The 4-card builds win on <i>acquisition</i> ($/tok-s, see table), not on watts.`
      : `<b>120B · idle (standing cost).</b> Off-when-idle erases the multi-GPU penalty: <b style="color:#4fc3f7">4× 3090</b>/<b style="color:#f3b54c">4× V100</b> idle ~160W (~$240/yr if left on), <b style="color:#ec5c9d">4× PG199</b> ~200W (~$300/yr), vs <b style="color:#ffab40">Strix Halo</b> 15W (~$22/yr) and <b style="color:#ce93d8">M3 Ultra</b> 20W. These GPU-idle figures are rough (swing with persistence mode + power caps); since you power down between sessions, idle changes how you run the box, not whether it's viable.`;
  }
  return isLoad
    ? `<b>35B-A3B MoE on the big box.</b> Wasteful for single-stream (it fits one 32GB card), but if you run it here: <b style="color:#00e676">PRO 6000</b> leads (~0.63 tok/s/W), unified boxes ~0.3–0.5. The honest value play for this model is a <i>single</i> discrete GPU (R9700/used V100), not a 96–128GB build — see the single-card analysis above.`
    : `<b>35B-A3B MoE · idle.</b> Same idle picture as 120B — the build's idle draw doesn't change with the model. Multi-GPU rigs ~200–280W, unified ~15–20W. Off-when-idle neutralizes it.`;
}

export const captionFor = (model, arch, kind) => {
  const desc = model.ARCH_DESC[arch];
  if (kind === 'pp') return `${desc} · prefill throughput (tokens/sec)`;
  if (kind === 'tg') return `${desc} · decode rate (tokens/sec) · single-stream`;
  if (kind === 'ss') return `${desc} · steady-state turn: append 2K to a 16K-deep warm session + 2K generated`;
  return `${desc} · cold-start wall-clock: 16K-token prompt from empty + 2K generated`;
};

export const valueCaption = (valModel, valPower) => {
  const label = valModel === 'tg120' ? 'gpt-oss-120B' : '35B-A3B MoE';
  const isLoad = valPower === 'load';
  return {
    main: label + (isLoad ? ' · tokens/sec per watt under load' : ' · idle draw (standing cost if left on)'),
    sub: isLoad
      ? 'higher = better · power estimated'
      : 'lower = better · $0.17/kWh · off-when-idle = upper bound',
  };
};
