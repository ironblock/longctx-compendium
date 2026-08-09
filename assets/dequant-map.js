// Which compute precision a GGUF quant family actually executes a matmul at,
// per GPU architecture generation. Grounded in real kernel dispatch code --
// see docs/roofline-dequant-paths.md for the full writeup and citations this
// table is transcribed from. Do not hand-edit an entry without updating that
// doc; they are one finding, kept in two forms for two audiences.

/**
 * quantFamily x archFamily -> { precision, confidence, note }. Absent
 * combinations are real gaps (see docs/roofline-dequant-paths.md's "Where
 * this table should NOT be trusted yet") -- callers must fall back to a
 * documented-safe floor (fp16) rather than guess, and say that they did.
 */
export const PRECISION_MAP = {
  kquant: {
    volta: { precision: 'fp16', confidence: 'e', note: 'Large-batch prefill only (no int8 tensor-core path pre-Turing); decode uses int8 DP4A instead. mmq.cu:319-321.' },
    ampere: { precision: 'int8', confidence: 'm', note: 'MMQ int8 tensor-core MMA (mma.sync s32.s8.s8.s32), unconditional once turing_mma_available(cc). mmq.cu:307-309; mma.cuh:920-968.' },
    ada: { precision: 'int8', confidence: 'm', note: 'Same mechanism as ampere. mmq.cu:307-309; mma.cuh:920-968.' },
    hopper: { precision: 'int8', confidence: 'm', note: 'Same mechanism as ampere/ada. mmq.cu:307-309; mma.cuh:920-968.' },
    blackwell: { precision: 'int8', confidence: 'e', note: 'Not directly evidenced -- mmq_type_traits<Q8_0> has no BLACKWELL_MMA_AVAILABLE branch, implying the same int8 path as Turing+. Gap, see docs/roofline-dequant-paths.md.' },
    cdna3: { precision: 'int8', confidence: 'm', note: 'ROCm 7.0 forces MMQ int8 MFMA unconditionally regardless of batch. mmq.cu:323-329; mma.cuh:1305-1337.' },
    cdna2: { precision: 'fp16', confidence: 'm', note: 'Batch-gated (ne11<=128-256 stays int8); ggml explicitly prefers dequant+hipBLAS fp16 beyond that, even though int8 MFMA hardware exists. mmq.cu:323-339.' },
    rdna3: { precision: 'int8', confidence: 'm', note: 'Default-true WMMA int8 for most K-quant types (Q6_K has its own ne11 ceiling). mmq.cu:342-369.' },
    rdna4: { precision: 'int8', confidence: 'm', note: 'Unconditional WMMA int8 at every batch size. mmq.cu:342,368.' },
    apple: { precision: 'fp16', confidence: 'e', note: 'Dequant to half4x4, simdgroup_half8x8 MMA, fp32 accumulate. ggml-metal.metal:9560-9567.' },
    xe2: { precision: 'fp16', confidence: 'i', note: 'Int8 MMQ kernel exists but ggml_sycl_supports_mmq() always returns false -- dead code. Real path is oneDNN fp16 matmul; XMX/DPAS usage unconfirmed (closed-source internals). ggml-sycl.cpp:3503-3507.' },
  },
  legacy8bit: {
    volta: { precision: 'fp16', confidence: 'e', note: 'Same Volta mechanism as kquant.' },
    ampere: { precision: 'int8', confidence: 'm', note: 'Q8_0 grouped with K-quants in this dispatch path. mmvq.cu:280,324; mma.cuh:920-968.' },
    ada: { precision: 'int8', confidence: 'm', note: 'Same as ampere/hopper.' },
    hopper: { precision: 'int8', confidence: 'm', note: 'Same as ampere/ada.' },
    blackwell: { precision: 'int8', confidence: 'e', note: 'Inferred, not directly tested -- see kquant/blackwell.' },
    cdna3: { precision: 'int8', confidence: 'm', note: 'Same CDNA3 unconditional-MMQ mechanism as kquant.' },
    rdna3: { precision: 'int8', confidence: 'm', note: 'Q8_0 not in the special-cased ne11-gated list -- default-true int8. mmq.cu:342-369.' },
    rdna4: { precision: 'int8', confidence: 'm', note: 'Unconditional int8 WMMA, same as kquant.' },
    apple: { precision: 'fp16', confidence: 'e', note: 'Same generic dequant-to-half4x4 path as kquant.' },
    xe2: { precision: 'fp16', confidence: 'i', note: 'Same dead-MMQ / oneDNN-fp16-fallback situation as kquant.' },
  },
  iq: {
    volta: { precision: 'fp16', confidence: 'e', note: 'Same Volta batch-gated mechanism as kquant/legacy8bit.' },
    ampere: { precision: 'int8', confidence: 'm', note: 'Grouped with K-quants; IQ1_M specifically has no MMQ struct and always falls to fp16. mmq.cu:307-309; ggml-cuda.cu:1656-1661.' },
    ada: { precision: 'int8', confidence: 'm', note: 'Same as ampere/hopper.' },
    hopper: { precision: 'int8', confidence: 'm', note: 'Same as ampere/ada.' },
    blackwell: { precision: 'int8', confidence: 'e', note: 'Inferred, not directly tested -- see kquant/blackwell.' },
    cdna3: { precision: 'int8', confidence: 'm', note: 'Same CDNA3 unconditional-MMQ mechanism.' },
    rdna3: { precision: 'int8', confidence: 'm', note: 'Default-true for most IQ types (IQ2_XS/IQ2_S have their own sub-gate). mmq.cu:342-369.' },
    rdna4: { precision: 'int8', confidence: 'm', note: 'Unconditional int8 WMMA at every batch size.' },
    apple: { precision: 'fp16', confidence: 'e', note: 'Same generic dequant-to-half4x4 path.' },
    xe2: { precision: 'fp16', confidence: 'i', note: 'Same dead-MMQ / oneDNN-fp16-fallback situation.' },
  },
  mxfp4: {
    ampere: { precision: 'int8', confidence: 'm', note: '4-bit e2m1 code -> int8 lookup table -> reused Q8_0 int8 tensor-core MMA kernel (non-Blackwell branch). mmq.cuh:3316-3327.' },
    ada: { precision: 'int8', confidence: 'm', note: 'Same non-Blackwell int8-emulated path as ampere.' },
    hopper: { precision: 'int8', confidence: 'm', note: 'Same non-Blackwell int8-emulated path.' },
    blackwell: { precision: 'fp4', confidence: 'm', note: 'Genuinely native block-scaled FP4 MMA, PTX mma.sync.aligned.kind::mxf4.block_scale...e2m1.e2m1.f32.ue8m0. mmq.cuh:3317-3327; common.cuh:286-288; mma.cuh:1126-1154.' },
  },
  nvfp4: {
    ampere: { precision: 'int8', confidence: 'm', note: 'Same int8-lookup-table mechanism as MXFP4. mmq.cuh:3329-3340.' },
    ada: { precision: 'int8', confidence: 'm', note: 'Same non-Blackwell int8-emulated path as ampere.' },
    hopper: { precision: 'int8', confidence: 'm', note: 'Same non-Blackwell int8-emulated path.' },
    blackwell: { precision: 'fp4', confidence: 'm', note: 'Native block-scaled FP4 MMA, PTX kind::mxf4nvf4.block_scale...e2m1.e2m1.f32.ue4m3. mmq.cuh:3329-3340.' },
  },
};

/**
 * Which architecture generation each catalog unit's silicon actually is --
 * public, well-established hardware facts (die/generation names), not
 * re-derived by the dequant-path research above. Kept here rather than in
 * data/compendium.json because it's a classification the roofline model
 * needs, not a benchmarked or priced fact the rest of the page's schema is
 * built around.
 */
export const UNIT_ARCH_FAMILY = {
  rtx_pro_6000: 'blackwell',
  rtx_5090: 'blackwell',
  dgx_spark: 'blackwell', // GB10 Superchip
  b200: 'blackwell',
  b300: 'blackwell',
  radeon_r9700: 'rdna4', // Navi 48, same die generation as RX 9070
  strix_halo: 'rdna3', // RDNA 3.5 -- no distinct bucket in PRECISION_MAP; treated as rdna3, which is where the research itself places the "RDNA3.5 sub-variant" Q6_K threshold
  arc_b70: 'xe2', // Battlemage
  arc_b65: 'xe2',
  v100_sxm2: 'volta',
  rtx_3090: 'ampere',
  rtx_3090_ti: 'ampere',
  rtx_a6000: 'ampere',
  a100_80: 'ampere',
  pg199_card: 'ampere', // DRIVE Orin/A100-class per its own catalog note
  rtx_4090: 'ada',
  rtx_6000_ada: 'ada',
  l40s: 'ada',
  h100_sxm: 'hopper',
  h100_pcie: 'hopper',
  h200: 'hopper',
  mac_m3_ultra: 'apple',
  mi300x: 'cdna3',
  mi325x: 'cdna3',
  mi355x: 'cdna3', // genuinely CDNA4 -- no CDNA4 bucket in PRECISION_MAP (a gap in this research pass's requested schema, not the silicon); approximated as cdna3, flagged low-confidence by callers
  mi210: 'cdna2',
  radeon_pro_w7900: 'rdna3',
  rx_7900_xtx: 'rdna3',
};

/**
 * Compute precision a quant family executes at on a given catalog unit,
 * falling back to the documented-safe floor (dequant-to-fp16) when the
 * research has no grounded answer for that combination -- and saying so,
 * rather than silently assuming a faster path than what was confirmed.
 */
export function dequantPrecisionFor(quantFamily, unitId) {
  const archFamily = UNIT_ARCH_FAMILY[unitId];
  const entry = archFamily ? PRECISION_MAP[quantFamily]?.[archFamily] : null;
  if (entry) return { ...entry, archFamily, grounded: true };
  return {
    precision: 'fp16',
    confidence: 'i',
    note: archFamily
      ? `No grounded finding for ${quantFamily} on ${archFamily} -- fp16 dequant-floor assumed (conservative: real ceiling may be higher).`
      : `Unit "${unitId}" has no architecture-family classification -- fp16 dequant-floor assumed.`,
    archFamily: archFamily ?? null,
    grounded: false,
  };
}
