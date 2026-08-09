# In order of preference, this dequants to...

Which compute precision a GGUF-quantized weight actually executes a matmul at,
per GPU architecture generation — grounded in real kernel dispatch code from
`llama.cpp`/`ggml` (upstream, current checkout) and cross-checked against the
`beellama.cpp` production fork, not recalled or inferred from silicon
capability alone. This is the source behind `assets/dequant-map.js`, which the
roofline table (`assets/roofline-ui.js`) and outlier checker
(`tools/roofline-check.mjs`) both read.

**Silicon capability and software support are different questions, and this
whole exercise exists because they get conflated.** A GPU generation having
fp8 or fp4 tensor cores does not mean ggml's kernels actually use them for a
given quant type — the dispatch logic decides that, batch-size and
architecture both, and it has to be read, not assumed.

Confidence codes are this compendium's own vocabulary: **m** = confirmed by
dispatch/kernel-selection code actually read · **e** = traced end-to-end to
the literal instruction/intrinsic level and cross-verified · **i** =
indeterminate, a real gap this source tree cannot resolve. Findings are for
the **compute-bound (large-batch/prefill) regime** unless noted — that's what
a roofline ceiling targets; decode-time (small-batch, memory-bound) dispatch
sometimes differs and is called out separately where it does.

## The one-line summary, if you read nothing else

**Legacy/K-quants (Q4_K/Q5_K/Q6_K, Q8_0, IQ-series) execute at INT8, not
FP16, on every modern NVIDIA (Turing+) and AMD (RDNA3+/CDNA3) part** — an
integer tensor-core MMA kernel, not a dequant-to-fp16-then-GEMM. INT8
throughput is typically ~2x the FP16 rate on these architectures (see this
catalog: RTX PRO 6000 is FP16 500 / INT8 1000, exactly 2x), so a roofline
ceiling that assumed FP16 for these quants — which is what this page's table
did before this research landed — **understated the true prefill ceiling for
most of the catalog by roughly 2x.**

**MXFP4/NVFP4 only get genuine native FP4 tensor cores on Blackwell.**
Everywhere else — Ampere, Ada, Hopper — they fall back to the *exact same*
INT8 emulated path as legacy Q8_0. This is real, sourced confirmation of the
intuition this section was commissioned to check: NVFP4 is fast on Blackwell
specifically because Blackwell is the only generation where it isn't secretly
running as INT8 underneath.

**FP8 is not a GGUF weight-storage format at all, on any architecture.**
`enum ggml_type` has no F8/FP8/E4M3/E5M2 member — confirmed by a repo-wide
grep returning zero hits, cross-checked against both `llama.cpp` and the
`beellama.cpp` fork. e4m3/e8m0 appear only as a per-block *scale codec* for
MXFP4/NVFP4, never as the GEMM operand type. Where this page shows an "FP8"
option, it models a hypothetical native-fp8 checkpoint (the kind vLLM serves
from safetensors, like the PRO 6000 fp8 citation already in this page's own
Method & sources) — not a GGUF quant, because that quant does not exist.

## K-quants (Q4_K/Q5_K/Q6_K), Q8_0, IQ-series

Dispatched near-identically across `ggml-cuda`/`ggml-hip`/`ggml-metal`, so
grouped here; exceptions are called out.

| Arch generation | Precision | Conf | Basis |
|---|---|---|---|
| NVIDIA Pascal (cc 610-699) | **int8** | m | `ggml_cuda_should_use_mmq` collapses to always-true (`mmq.cu:319-321`; `fp16_mma_hardware_available` false below cc 700, `common.cuh:316-320`) — int8 DP4A at every batch size. *(No catalog unit needs this bucket.)* |
| NVIDIA Volta (cc 700) | **fp16** (prefill, ne11≥64) / int8 (decode) | e | No `TURING_MMA_AVAILABLE` (cc≥750 required) — large batch falls to `ggml_cuda_op_mul_mat_cublas`, dequant-to-`half`, `cublasGemmEx(CUDA_R_16F)` (`mmq.cu:319-321`; `mmq.cuh:12`; `ggml-cuda.cu:1656-1745`). |
| NVIDIA Turing/Ampere/Ada/Hopper | **int8** | m | Decode: MMVQ scalar `__dp4a` (`mmvq.cu:280,324`). Prefill: MMQ int8 tensor-core MMA, PTX `mma.sync...s32.s8.s8.s32` (`mma.cuh:920-968`), unconditional once `turing_mma_available(cc)` (`mmq.cu:307-309`). |
| NVIDIA Blackwell (plain K-quants/Q8_0/IQ) | — | — | **Not directly evidenced.** `mmq_type_traits<Q8_0>` has no `BLACKWELL_MMA_AVAILABLE` branch, implying the same int8 path as Turing+, but untested. Gap — this table currently falls back to the int8 assumption via the ampere/ada/hopper rows, flagged low-confidence. |
| AMD CDNA3 (MI300/325/355 as pinned here) | **int8** | m | ROCm 7.0 rocBLAS/hipBLASLt regression forces MMQ (int8 MFMA) unconditionally regardless of batch (`mmq.cu:323-329`; MFMA `i32_16x16x32_i8`, `mma.cuh:1305-1337`). |
| AMD CDNA2 (MI210) — K-quant only | **fp16** (large batch) | m | Batch/type-gated: Q4_K/Q5_K int8 only to `ne11<=256`; Q2_K/Q3_K/Q6_K only to `ne11<=128`; beyond that ggml explicitly *prefers* dequant+hipBLAS fp16 over the int8 MFMA hardware it has (`mmq.cu:323-339`). Q8_0/IQ not individually disambiguated for CDNA2 — omitted rather than guessed. |
| AMD RDNA3 (incl. RDNA3.5/Strix Halo) | **int8** | m | Default-true WMMA int8 for most types; Q6_K has an `ne11<=128` (256 on RDNA3.5) ceiling above which it falls back to fp16 (`mmq.cu:342-369`). |
| AMD RDNA4 | **int8** | m | Unconditional WMMA int8 at every batch size — "MMQ is consistently faster than dequantization + hipBLAS" per the cited upstream PR (`mmq.cu:342,368`). |
| Apple (batch>8) | **fp16** | e/m | Dequant to `half4x4` → `simdgroup_half8x8` MMA (M1-M4/A14-A18) or the newer `mpp::tensor_ops` cooperative-tensor path (M5/M6/A19/A20, name-gated), fp32 accumulate (`ggml-metal.metal:9560-9567,9436-9496`). |
| Apple, decode (ne11≤8) | — | — | **Gap.** A separate matrix-vector kernel dispatches; its precision was never confirmed. |
| Intel Xe2 (Arc B-series) | **fp16** (as dispatched) | i | The int8 MMQ kernel exists in source but `ggml_sycl_supports_mmq()` unconditionally `return false`s — dead code (`ggml-sycl.cpp:3503-3507`). Real path: oneDNN `dnnl::matmul`, fp16 operands. Whether that lands on XMX/DPAS hardware or generic vector ALUs is **not visible from this codebase** — closed-source oneDNN/oneMKL internals. |

**IQ-series caveat**: IQ1_M has no `mmq_type_traits` entry — it can never
take the tensor-core path at any batch size, always falling to fp16-dequant
(`ggml-cuda.cu:1656-1661`).

## MXFP4 / NVFP4

Despite the name, neither runs as floating-point arithmetic anywhere except
Blackwell.

| Arch generation | Precision | Conf | Basis |
|---|---|---|---|
| Any NVIDIA (incl. Blackwell), decode (ne11≤8) | **int8** | m | MMVQ has no cc-gate (`mmvq.cu:280,324`); the 4-bit e2m1 code is looked up through an int8 table (`kvalues_mxfp4`, `ggml-common.h:1114-1119`) and dot-producted via `ggml_cuda_dp4a`. Even single-token decode on Blackwell does **not** get native fp4. |
| Turing/Ampere/Ada/Hopper, prefill | **int8** | m | Same int8-lookup table feeds the identical int8 tensor-core MMA machinery as legacy Q8_0, gated by the non-Blackwell branch of `mmq_type_traits` (`mmq.cuh:3316-3340`). |
| Blackwell, prefill | **fp4** | m | Genuinely native block-scaled FP4 MMA — literal PTX `mma.sync.aligned.kind::mxf4[nvf4].block_scale...e2m1.e2m1.f32.ue8m0/ue4m3` (`mma.cuh:1126-1154`), gated by `BLACKWELL_MMA_AVAILABLE` (`common.cuh:286-288`). |
| AMD, Apple, Intel | — | — | **Not examined** — not proven absent, just never checked. |

## FP8 (e4m3/e5m2) as a GGUF weight-storage format

Confirmed absent, not a coverage gap. See the summary above.

## Where this table should NOT be trusted yet

- **Blackwell for plain K-quants/Q8_0/IQ** — inferred from code structure (no `BLACKWELL_MMA_AVAILABLE` branch on the Q8_0 traits), never directly tested against a Blackwell-specific finding.
- **Apple, decode/small-batch** — precision unconfirmed for any quant family.
- **CDNA1 and CDNA4 specifically**, and **Q8_0/IQ on CDNA2** — thresholds not fully disambiguated. `mi355x` in this catalog is genuinely CDNA4, mapped to the CDNA3 row below as an approximation, flagged accordingly.
- **MXFP4/NVFP4 on AMD, Apple, or Intel** — zero findings either way.
- **Intel Xe2's actual execution unit** (XMX/DPAS vs generic vector) — rated **i**, a claim about closed-source internals this source tree cannot settle.
- **Pascal** has a solid, well-evidenced answer (int8, unconditional) but no catalog unit needs it.

## The map, as consumed by code

`assets/dequant-map.js` — `PRECISION_MAP` (quantFamily × archFamily →
precision/confidence/note, exactly as tabulated above) and `UNIT_ARCH_FAMILY`
(which architecture generation each catalog unit's silicon actually is —
public, well-established hardware facts, not re-derived from this research
pass). Where a combination has no entry, callers fall back to FP16 explicitly
labeled "not grounded" — never silently assume a faster path than what was
actually confirmed.
