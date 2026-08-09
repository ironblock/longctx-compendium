#!/usr/bin/env node
// Compares every hand-mapped measured (m/m~) pp512/decode.short datapoint
// against its theoretical-maximum roofline ceiling, and flags anything that
// exceeds it (physically impossible given the hardware and quant this page
// itself attributes the measurement to) or sits suspiciously far under a
// conservative floor.
//
// WHY THE MAPPING BELOW IS HAND-CURATED, NOT DERIVED FROM perf.*.note: a
// note string like "llama.cpp Q4_K_XL, Qwen3.5-35B-A3B" is prose for a
// human, not a structured fact — fuzzy-parsing it here would reintroduce
// exactly the kind of confidently-wrong inference this whole exercise exists
// to catch (data/README.md's own words). Each row below was read from the
// actual note by a human/agent, once, and is checked against the SAME text
// every time this script runs — so a note that changes without updating the
// mapping fails loudly (see the guard at the bottom) instead of silently
// drifting.
//
//   node tools/roofline-check.mjs
//
// READING THE OUTPUT: "impossible" and "suspicious-low" are not the same
// severity. IMPOSSIBLE means the measurement exceeds a ceiling that already
// assumes perfect utilization -- something in the mapping (wrong quant,
// wrong model, wrong platform) or the measurement itself is wrong, full
// stop. suspicious-low is much weaker and, for pp512 rows specifically, is
// EXPECTED rather than alarming: batch=512 rarely reaches a modern GPU's
// compute ridge point, so pp512 sitting at 6-11% of the pure-compute
// ceiling is the same small-batch-underutilization effect this page's own
// prefill curves already show rising well past 512 tokens (see
// data/README.md's "Prefill is a per-event cost" section). Read
// suspicious-low as "worth a second look at the note," not "probably fake"
// -- that judgment is IMPOSSIBLE's job.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { theoreticalPrefillDecode, BPW_TABLE, classifyAgainstCeiling, platformComputeRateForQuant } from '../assets/roofline.js';
import { MODELS } from '../assets/models.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/compendium.json'), 'utf8'));

const unitById = Object.fromEntries((doc.units ?? []).map(u => [u.id, u]));
const platformById = Object.fromEntries(doc.platforms.map(p => [p.id, p]));

/** Mirrors assets/roofline-ui.js's QUANT_INFO -- which dequant-map.js
 *  quantFamily each GGUF quant belongs to, so the ceiling here uses the
 *  SAME grounded per-architecture precision the live page shows, not an
 *  independent guess. */
const QUANT_FAMILY = { q4_k_m: 'kquant', q8_0: 'legacy8bit', mxfp4: 'mxfp4', nvfp4: 'nvfp4' };

function platformRates(platformId, quant) {
  const p = platformById[platformId];
  return p ? platformComputeRateForQuant(p, unitById, QUANT_FAMILY[quant], null) : null;
}

/**
 * Each row: which platform/archetype/metric this checks, the note text it
 * must still match (the drift guard), and which model+quant it names. The
 * compute precision is no longer hand-guessed here -- it comes from
 * dequant-map.js's grounded quantFamily x architecture-family findings
 * (docs/roofline-dequant-paths.md), resolved per platform below.
 */
const CHECKS = [
  { platform: 'pro6000', arch: 'moe', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen3-30B-A3B', model: 'qwen3_30b_a3b', quant: 'q4_k_m' },
  { platform: 'pro6000', arch: 'moe', metric: 'decode', noteContains: 'llama.cpp Q4_K_M', decodeNoteContains: 'llama.cpp Q4_K_M', model: 'qwen3_30b_a3b', quant: 'q4_k_m' },
  { platform: 'pro6000', arch: 'dense', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen2.5-32B proxy', model: 'qwen25_32b', quant: 'q4_k_m' },
  { platform: 'pro6000', arch: 'oss120b', metric: 'decode', decodeNoteContains: 'vLLM millstoneai', model: 'gpt_oss_120b', quant: 'mxfp4', note: 'Blackwell -- grounded native-fp4 path per docs/roofline-dequant-paths.md, but this measurement is vLLM native-MXFP4, not llama.cpp -- lower engine-comparability confidence than the llama.cpp CUDA rows below.' },

  { platform: 'rtx5090', arch: 'moe', metric: 'prefill', ctxKey: '4096', noteContains: 'Q4_K_XL, Qwen3moe-30B-A3B', model: 'qwen3_30b_a3b', quant: 'q4_k_m', note: 'Q4_K_XL (unsloth dynamic) approximated as Q4_K_M bpw -- both ~4.5-5 bpw, exact recipe differs per tensor.' },
  { platform: 'rtx5090', arch: 'moe', metric: 'decode', decodeNoteContains: 'hardware-corner; 52 @147K', model: 'qwen3_30b_a3b', quant: 'q4_k_m' },
  { platform: 'rtx5090', arch: 'dense', metric: 'prefill', ctxKey: '4096', noteContains: 'Q4_K_XL, Qwen3-32B', model: 'qwen3_32b', quant: 'q4_k_m' },
  { platform: 'rtx5090', arch: 'dense', metric: 'decode', decodeNoteContains: 'hardware-corner Q4_K_XL', model: 'qwen3_32b', quant: 'q4_k_m' },

  { platform: 'r9700', arch: 'moe', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_XL, Qwen3.5-35B-A3B', model: 'qwen35_35b_a3b', quant: 'q4_k_m' },
  { platform: 'r9700', arch: 'moe', metric: 'decode', decodeNoteContains: 'llama.cpp Vulkan Q4_K_XL', model: 'qwen35_35b_a3b', quant: 'q4_k_m' },

  { platform: 'dgxspark', arch: 'moe', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen3-30B-A3B', model: 'qwen3_30b_a3b', quant: 'q4_k_m', note: 'Blackwell mobile (GB10) -- kquant/blackwell is inferred (e), not directly tested; see docs/roofline-dequant-paths.md.' },
  { platform: 'dgxspark', arch: 'dense', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen3-32B', model: 'qwen3_32b', quant: 'q4_k_m' },
  { platform: 'dgxspark', arch: 'dense', metric: 'decode', decodeNoteContains: 'DandinPower "bandwidth wall"', model: 'qwen3_32b', quant: 'q4_k_m' },
  { platform: 'dgxspark', arch: 'oss120b', metric: 'prefill', ctxKey: '4096', noteContains: 'MXFP4; pp ~1723', model: 'gpt_oss_120b', quant: 'mxfp4', note: 'Blackwell mobile -- grounded native-fp4 path (m confidence) per docs/roofline-dequant-paths.md.' },

  { platform: 'm3ultra', arch: 'dense', metric: 'prefill', ctxKey: '32768', noteContains: 'mlx-lm 4-bit, Qwen3-32B', model: 'qwen3_32b', quant: 'q4_k_m', note: 'MLX 4-bit is not GGUF Q4_K_M -- treated as bpw-equivalent for this check; Apple/kquant precision (fp16, e confidence) is grounded via docs/roofline-dequant-paths.md, though MLX itself is not the same kernel this was traced from.' },
  { platform: 'm3ultra', arch: 'dense', metric: 'decode', decodeNoteContains: 'mlx #3209', model: 'qwen3_32b', quant: 'q4_k_m' },

  { platform: 'strixhalo', arch: 'moe', metric: 'prefill', ctxKey: '512', noteContains: 'Q4, Qwen3.6-35B-A3B', model: 'qwen36_35b_a3b', quant: 'q4_k_m' },
  { platform: 'strixhalo', arch: 'dense', metric: 'prefill', ctxKey: '512', noteContains: 'Vulkan, Mistral-24B proxy', model: 'mistral_24b', quant: 'q4_k_m' },
  { platform: 'strixhalo', arch: 'dense', metric: 'decode', decodeNoteContains: 'Q8_0 27B', model: 'qwen35_27b', quant: 'q8_0', note: "Deliberately included even though it names a DIFFERENT model (Qwen 27B) and quant (Q8_0) than this row's own prefill cell (Mistral-24B, implicitly Q4) -- exactly the FACTCHECK-2026-08-08.md finding B1. This check is what would have caught it mechanically." },
  { platform: 'strixhalo', arch: 'oss120b', metric: 'prefill', ctxKey: '4096', noteContains: 'MXFP4; pp ~340', model: 'gpt_oss_120b', quant: 'mxfp4', note: 'AMD RDNA3.5 iGPU -- MXFP4/NVFP4 on AMD is an unexamined gap per docs/roofline-dequant-paths.md, fp16 floor assumed, not the int8-emulated or native-fp4 paths grounded for NVIDIA.' },

  { platform: 'b70', arch: 'moe', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen3.6-35B-A3B', model: 'qwen36_35b_a3b', quant: 'q4_k_m', note: 'Intel Xe2 kquant precision is i-confidence (fp16 fallback, XMX/DPAS usage of the real oneDNN path unconfirmed) -- see docs/roofline-dequant-paths.md.' },
  { platform: 'b70', arch: 'dense', metric: 'prefill', ctxKey: '512', noteContains: 'Q4_K_M, Qwen3.5-27B', model: 'qwen35_27b', quant: 'q4_k_m' },
];

const results = [];
for (const chk of CHECKS) {
  const platform = platformById[chk.platform];
  const perf = platform?.perf?.[chk.arch];
  if (!perf) { results.push({ ...chk, error: `no perf.${chk.arch} on platform "${chk.platform}"` }); continue; }

  const noteText = perf.note ?? '';
  const decodeNoteText = perf.decodeNote ?? perf.note ?? '';
  if (chk.noteContains && !noteText.includes(chk.noteContains)) {
    results.push({ ...chk, error: `DRIFT: note no longer contains "${chk.noteContains}" -- was "${noteText}". Re-check this mapping.` });
    continue;
  }
  if (chk.decodeNoteContains && !decodeNoteText.includes(chk.decodeNoteContains)) {
    results.push({ ...chk, error: `DRIFT: decodeNote no longer contains "${chk.decodeNoteContains}" -- was "${decodeNoteText}". Re-check this mapping.` });
    continue;
  }

  let measured;
  if (chk.metric === 'prefill') {
    const raw = perf.prefill?.[chk.ctxKey];
    measured = Array.isArray(raw) ? raw[0] : raw?.value;
  } else {
    const raw = perf.decode?.short;
    measured = Array.isArray(raw) ? raw[0] : raw?.value;
  }
  if (measured == null) { results.push({ ...chk, error: 'no measured value at the specified point' }); continue; }

  const model = MODELS[chk.model];
  const bpwEntry = BPW_TABLE[chk.quant];
  if (!model || !bpwEntry) { results.push({ ...chk, error: `unknown model "${chk.model}" or quant "${chk.quant}"` }); continue; }

  const rates = platformRates(chk.platform, chk.quant);
  const resolution = rates?.perUnitResolution?.[0];
  if (!rates || rates.opsPerSec == null || rates.bandwidthGBs == null) {
    const prec = resolution?.precision ?? '(unresolved)';
    results.push({ ...chk, error: `platform "${chk.platform}" has no ${prec} compute.values or bandwidth on its composition units -- cannot model a ceiling` });
    continue;
  }

  const { prefill, decode } = theoreticalPrefillDecode({
    opsPerSec: rates.opsPerSec,
    bandwidthGBs: rates.bandwidthGBs,
    activeParams: model.activeParams,
    bytesPerParam: bpwEntry.bpw / 8,
  });
  const ceiling = chk.metric === 'prefill' ? prefill : decode;
  const verdict = classifyAgainstCeiling(measured, ceiling.tokensPerSec);
  results.push({ ...chk, measured, ceiling: ceiling.tokensPerSec, bound: ceiling.bound, resolution, verdict });
}

// --- Report ------------------------------------------------------------
const errors = results.filter(r => r.error);
const impossible = results.filter(r => r.verdict?.verdict === 'impossible');
const suspicious = results.filter(r => r.verdict?.verdict === 'suspicious-low');
const plausible = results.filter(r => r.verdict?.verdict === 'plausible');

console.log(`roofline-check: ${CHECKS.length} mapped datapoints, ${plausible.length} plausible, ${suspicious.length} suspicious-low, ${impossible.length} IMPOSSIBLE, ${errors.length} mapping error(s)\n`);

const precTag = r => `${r.quant}/${r.resolution?.precision ?? '?'}${r.resolution?.grounded ? '' : ' (ungrounded, floor)'}`;

for (const r of impossible) {
  console.error(`✗ IMPOSSIBLE  ${r.platform}/${r.arch}/${r.metric}: measured ${r.measured.toFixed(1)} t/s > ceiling ${r.ceiling.toFixed(1)} t/s (${(r.verdict.ratio * 100).toFixed(0)}% of a ${r.bound}-bound roofline at ${precTag(r)}, model ${r.model})`);
  if (r.note) console.error(`  note: ${r.note}`);
}
for (const r of suspicious) {
  console.warn(`! suspicious-low  ${r.platform}/${r.arch}/${r.metric}: measured ${r.measured.toFixed(1)} t/s is only ${(r.verdict.ratio * 100).toFixed(0)}% of ceiling ${r.ceiling.toFixed(1)} t/s (${precTag(r)}, ${r.bound}-bound)`);
}
for (const r of errors) {
  console.error(`✗ MAPPING ERROR  ${r.platform}/${r.arch}/${r.metric}: ${r.error}`);
}

if (process.env.ROOFLINE_VERBOSE) {
  console.log('\nAll plausible datapoints:');
  for (const r of plausible) {
    console.log(`  ${r.platform}/${r.arch}/${r.metric}: measured ${r.measured.toFixed(1)}, ceiling ${r.ceiling.toFixed(1)} (${(r.verdict.ratio * 100).toFixed(0)}%, ${r.bound}-bound)`);
  }
}

if (impossible.length || errors.length) process.exit(1);
