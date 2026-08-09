// Parameter counts for the models this page's perf.* notes name. Kept
// separate from data/compendium.json rather than folded into its schema --
// these are facts about MODELS, not about the hardware/platform/build
// catalog compendium.json exists to hold, and the roofline calculation is
// the only thing here that needs them.
//
// Same sourcing discipline as everywhere else on this page: every entry
// carries where the number came from and a confidence code. 'm' entries were
// checked against a live source during this file's authoring (2026-08-08);
// 'e' entries are well-established pre-2026 facts recalled with high
// confidence but not re-fetched, since they predate the ambiguity that made
// the 2026-generation Qwen models worth checking in the first place.
export const MODELS = {
  qwen3_30b_a3b: {
    label: 'Qwen3-30B-A3B',
    totalParams: 30.5e9,
    activeParams: 3.3e9,
    confidence: 'm',
    source: 'https://huggingface.co/Qwen/Qwen3-30B-A3B',
  },
  qwen35_35b_a3b: {
    label: 'Qwen3.5-35B-A3B',
    totalParams: 35e9,
    activeParams: 3e9,
    confidence: 'm',
    source: 'https://huggingface.co/Qwen/Qwen3.5-35B-A3B',
    note: 'Treated as parameter-count-equivalent to Qwen3.6-35B-A3B below -- same total/active order of magnitude across every source found, exact routing config not independently confirmed identical.',
  },
  qwen36_35b_a3b: {
    label: 'Qwen3.6-35B-A3B',
    totalParams: 35e9,
    activeParams: 3.1e9,
    confidence: 'm',
    source: 'https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B ; https://openrouter.ai/qwen/qwen3.6-35b-a3b',
    note: '256 experts, 8 routed + 1 shared active per the Qwen blog per secondary summaries -- routing detail not independently re-derived, active-param total is.',
  },
  qwen35_27b: {
    label: 'Qwen3.5-27B',
    totalParams: 27e9,
    activeParams: 27e9,
    confidence: 'e',
    source: 'Treated as parameter-count-equivalent to Qwen3.6-27B below (same dense-27B generation lineage) -- not independently re-fetched.',
  },
  qwen36_27b: {
    label: 'Qwen3.6-27B',
    totalParams: 27e9,
    activeParams: 27e9,
    confidence: 'm',
    source: 'https://qwen.ai/blog?id=qwen3.6-27b ; independently confirmed via this program’s own production server (hybrid Gated DeltaNet attention, but dense/all-weights-active in the MoE sense -- see docs/mechanisms.md in the diet-inference repo)',
  },
  qwen3_32b: {
    label: 'Qwen3-32B',
    totalParams: 32.8e9,
    activeParams: 32.8e9,
    confidence: 'e',
    source: 'Qwen3 technical report / HF model card (pre-2026, not re-fetched for this table) -- genuinely full-attention dense, unlike the 3.5/3.6-27B generation.',
  },
  qwen25_32b: {
    label: 'Qwen2.5-32B',
    totalParams: 32.5e9,
    activeParams: 32.5e9,
    confidence: 'e',
    source: 'Qwen2.5 technical report / HF model card (pre-2026, not re-fetched for this table).',
  },
  mistral_24b: {
    label: 'Mistral-Small-24B (Mistral Small 3)',
    totalParams: 24e9,
    activeParams: 24e9,
    confidence: 'e',
    source: 'Mistral AI release blog (pre-2026, not re-fetched for this table).',
  },
  llama33_70b: {
    label: 'Llama-3.3-70B',
    totalParams: 70.6e9,
    activeParams: 70.6e9,
    confidence: 'e',
    source: 'Meta Llama 3.3 model card (pre-2026, not re-fetched for this table).',
  },
  gpt_oss_120b: {
    label: 'gpt-oss-120B',
    totalParams: 116.8e9,
    activeParams: 5.1e9,
    confidence: 'm',
    source: 'https://arxiv.org/pdf/2508.10925 (gpt-oss model card): 36 layers, 116.8B total, 5.1B active/token (MLP 114.71B + attention 0.96B + embed/unembed 1.16B).',
  },
};

/** Every model this table has no entry for, so a caller can render a real
 *  gap instead of a wrong number -- same "no data beats a guess" rule as
 *  the rest of this page. */
export const modelFor = id => MODELS[id] ?? null;
