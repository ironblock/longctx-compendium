# Editing the data

Every hardware fact and every measured number the page shows lives in
[`compendium.json`](./compendium.json); every model shape lives in
[`../assets/models.js`](../assets/models.js). Nothing that can be computed is
stored: rig totals, format support per card, ceilings and each reading's share
of its ceiling are all derived at render time, so nothing on the page can
disagree with the data behind it.

After any edit:

```sh
node tools/validate.mjs        # schema + cross-record checks
node tools/check-ceilings.mjs  # no reading above its own ceiling
node tools/coverage.mjs        # what the catalog is still missing
```

## The four collections

| collection | what it is | changes when |
|---|---|---|
| `architectures` | a chip generation and which matrix formats its silicon takes | a whitepaper was misread |
| `units` | a purchasable card or machine — what a datasheet describes | a price moves, a spec is corrected |
| `lines` | the ledger: every reading, inside the serving line that produced it | someone measures something |
| `candidates` | rigs under consideration that have no measured line yet | a rig is proposed or measured |

There is deliberately nothing between hardware and readings. The old page kept
"platforms" with prefill curves drawn through one or two measured points and
filled in by interpolation or spec-based modeling; none of that survives here.
What the hardware *could* do is computed from the catalog (see Ceilings below);
what it *did* do is a reading in a line. A number that is neither has no home.

## Chip generations carry format support

Whether a card's matrix units (tensor cores, MFMA, WMMA, XMX) take FP8, FP4,
BF16 and so on is a property of its generation, not of the card, so it is
recorded once:

```json
{
  "id": "ampere",
  "vendor": "NVIDIA",
  "label": "Ampere",
  "matrixUnits": "3rd-gen Tensor Cores",
  "formats": { "tf32": "native", "bf16": "native", "fp16": "native", "fp8": "absent",
               "fp6": "absent", "fp4": "absent", "int8": "native", "int4": "native" },
  "sources": [{ "url": "https://…", "quote": "…", "supports": ["bf16", "fp8:absent"] }]
}
```

Each format is `native` (the matrix units take that input type), `absent` (they
do not — emulating it or upcasting to a wider type does not count), or
`unknown` (no source either way). An `absent` needs a source as much as a
`native` does; usually it is a document that lists every supported type.
The validator holds this literally: every `native` or `absent` must appear as a
token in some source's `supports` list (`"fp16"` for native, `"fp8:absent"` for
absent). A claim no source carries has to be `unknown`. Apple publishes no list
of the types its GPUs multiply natively, but it does say GPUs before M5 have no
neural accelerators, so M3 and M4 are all `absent`; M5 is `native` only where
a source shows it.

A card names its generation with `"arch": "ampere"` and inherits all of this.
Where a card genuinely differs from its generation, `formatOverrides` says how,
and the unit's `note` must say why. A card's rated figure for a format proves
the matrix path exists, so a rated FP8 number on a generation marked FP8
`absent` is rejected: one of the two is wrong.

FP8 *storage* is a different question. Any card can hold FP8 weights and upcast
them; that saves memory and bandwidth, and decode is bound by both, but it is
not FP8 compute.

## Adding a card

```json
{
  "id": "some_card",
  "label": "Some Accelerator 48GB",
  "vendor": "NVIDIA",
  "arch": "ada",
  "released": "2025-04",
  "memoryGB": 48,
  "memoryBandwidthGBs": 1008,
  "tdpW": 300,
  "process": "TSMC 4N",
  "compute": {
    "unit": "Tops",
    "source": "https://…",
    "values": { "fp32": 91.1, "bf16": 362.1, "fp8": 724.2, "fp8:sparse": 1448.4 }
  },
  "pricing": {
    "msrp":   { "usd": 4500, "asOf": "2025-04" },
    "street": { "usd": 6200, "asOf": "2026-07", "note": "memory-shortage inflated" }
  },
  "sources": ["https://…"]
}
```

Only `id` and `label` are required; a card with nothing else renders as a row of
dashes with every format "not sourced". `compute.values` are **dense** rated
figures in 10¹² ops/sec; suffix a key with `:sparse` for the 2:4
structured-sparsity rate vendors often quote unlabelled. A card with no matrix
units at all (Vega 20, RDNA 2) records its shader-ALU rates with `:vector`
(`"fp16:vector"` for packed FP16, `"int8:vector"` for dot-product INT8); a
vector figure never proves a matrix path. The ceilings use dense figures, and
fall back to the fastest vector figure only on a card whose generation has no
matrix formats at all. A figure whose dense-or-sparse status nobody states is
filed where the arithmetic puts it, with a note saying so (PG199's 900 TOPS).
A figure the vendor never published for that card -- worked out from its
other ratings (the RTX PRO 5000's per-SM ratios, Arc's XMX FP16) or taken from
a third party (H20) -- goes in `values` like any other, its key listed in
`compute.unofficial`, with `compute.note` saying how it was arrived at. The
page marks it, and any ceiling resting on it says "unofficial".

`memoryGB` is read as GiB, which is what vendors mean by "32 GB" of VRAM.
`street` is what every price on the page is summed from; give it an `asOf`.

`peerLink` says how many of these cards can exchange data GPU to GPU without
going through PCIe: NVLink, Infinity Fabric or Xe Link, on the vendor's own
bridge (an add-in card) or baseboard (an SXM or OAM module). `maxCards` is the
largest such group, `options` any smaller supported sizes (a 2-way and a 4-way
bridge), and 0 means the card has none. Name the `fabric`, say in `topology`
whether every card reaches every other (a switch) or only its neighbours (pairs,
a ring, a mesh), and give a `source` with a quote. A missing `peerLink` means
nobody has sourced it yet, and the page says "?" rather than treating the card
as unlinked. A NIC between machines (ConnectX, Thunderbolt) is a network, not a
peer link, and does not count.

`board` marks a card that carries several GPUs the host sees as separate
devices, such as the A16's four. `gpus` says how many, with a `source`. Memory,
bandwidth, compute and links are then one GPU's, so a model on the whole board
is split across GPUs like any multi-card rig, while `street` is the board's
price. The page counts GPUs and charges whole boards: four A16 GPUs cost one
board, five cost two. Its $ per GB and GB/s per $1k use the whole board, and its
`peerLink` counts GPUs, not boards (the Vega II Duo's on-board link joins 2).

### Specifications need a source

A unit carrying `released`, `memoryBandwidthGBs`, `tdpW`, `process` or any
`compute.values` must also carry `sources`. This is the one rule that exists
because of what this page is: every number here was originally produced by a
language model, and a plausible-looking specification with a real-looking
citation is worse than a blank cell. If you cannot say where a figure came from,
leave it out; `tools/coverage.mjs` will keep reminding you.

A `note` is the right home for a figure that is real but measures something
other than the field offered for it — a Server Edition number on a Workstation
record, an NPU throughput beside GPU figures, a unified-memory machine whose GPU
only gets part of the RAM by default.

### Unknown is not zero

A missing price makes every total that depends on it unknown, not zero; a
missing bandwidth means no ceiling, not a slow one. Blanks sort last in both
directions. There is no code for "no data" anywhere: leave the key out.

`power` (`loadW`, `idleW`) is draw observed under inference, per unit, and
deliberately not the datasheet `tdpW`. It is kept for future use; the page does
not currently derive anything from it.

## Adding a model

Ceilings need the model's shape, and it has to come from the published
`config.json`, not memory. Add an entry to `MODELS` in `assets/models.js`:

```js
qwen3_32b: {
  label: 'Qwen3-32B',
  repo: 'Qwen/Qwen3-32B',
  source: 'https://huggingface.co/Qwen/Qwen3-32B/raw/main/config.json',
  revision: '<repo commit sha>',
  params: { total: 32.8e9, active: 32.8e9, source: '<model card URL>', quote: '<the sentence it came from>' },
  layers: 64,
  layerTypes: { full_attention: 64 },
  heads: 64, kvHeads: 8, headDim: 128,
  maxPositions: 40960,
},
```

- `layerTypes` counts `full_attention`, `sliding_attention`, `linear_attention`
  and `ffn_only` layers, from the config's own `layer_types` list where it has
  one. They must sum to `layers`. This is the field that decides how decode cost
  grows with depth, and the one the old page got wrong: Qwen3.5/3.6/3.8-27B are
  dense in weights but hybrid in attention (48 Gated DeltaNet layers to 16 full
  ones), and comparing them with a full-attention 32B on raw tokens/sec mixes
  two different slopes.
- `slidingWindow` for sliding layers; `attention.full` / `attention.sliding`
  where a model uses two attention shapes (Gemma 4); `mla` for multi-head latent
  attention (GLM-4.7-Flash); `sparse.budget` for block-sparse "full" layers
  that read at most that many positions (Qwen3.8-Flash-Next); `linear` for the
  recurrent-state shape of linear-attention layers.
- `params.total` excludes vision towers and MTP heads; `params.active` is what a
  decoded token reads. Without `params`, a model can be named in a line but has
  no ceiling.

`tools/test-kv.mjs` checks every entry's layer arithmetic and holds the KV
formula against what first-party lines actually allocated.

## Ceilings

`assets/ceiling.js` computes, from catalog and model facts only:

- **Decode** (one stream, one token per pass) = memory bandwidth ÷ the bytes a
  step must read: active weights at the format's bits per weight, less an
  untied input embedding (a step reads one row of it), the whole KV cache of
  every full-attention layer (one compressed latent per position for MLA), the
  window of every sliding layer, the budget of a sparse layer, and the
  recurrent state of every linear layer. Under a layer split a single stream
  runs one card at a time and gets one card's bandwidth; under tensor parallel
  it gets all of them.
- **Prefill** = rated dense matrix throughput at the precision the engine
  actually multiplies in ÷ FLOPs per token (2 per active weight plus attention
  over the positions attended). The precision comes from `assets/dequant-map.js`,
  which records llama.cpp's own kernel dispatch per quant family and chip
  generation (`docs/roofline-dequant-paths.md`); anything ungrounded falls back
  to FP16 and says so. Datacenter Blackwell (`blackwell_dc`: B200, B300) is
  read through the Hopper column, because llama.cpp's Blackwell kernels target
  CC 12.0 only.
- **Fit** = all weights + KV at depth + recurrent state against every card's
  memory less 1 GiB each. Under tensor parallel, KV heads fewer than the cards
  are replicated, and an MLA latent cache is copied whole to every card.

Every simplification leans generous — perfect scaling, no launch or
synchronization cost, one weight width throughout — so a ceiling is an upper
bound. A reading above its own ceiling therefore means something in its
attribution is wrong, and `tools/check-ceilings.mjs` fails on it. The one
legitimate exception is speculative decoding, which can emit more than one token
per pass; those readings are shown against the ceiling but not held to it. The
same goes for a line whose `offload` says part of a metric ran on hardware the
unit's figures do not cover (`{ "to": "Apple Neural Engine", "metrics":
["prefill"], "note": "…" }`): a GPU-only ceiling does not bound it.

## Readings: serving lines

Every measured number belongs to exactly one **serving line**: a rig, an engine,
a set of weights, a cache and the flags it ran with.

```json
{
  "id": "l_some_rig_27b",
  "label": "Qwen3.8 27B · IQ3_S · llama.cpp · MTP n=2",
  "model": "qwen38_27b",
  "rig": { "units": [{ "unit": "rtx_3090", "count": 1 }], "host": { "name": "linux-pc", "ramGB": 32 } },
  "engine": { "name": "llama.cpp", "version": "…", "commit": "4ceb171…", "lineage": "upstream" },
  "quant": { "format": "GSQ-RCO IQ3_S", "key": "iq", "bpw": 3.4981, "sizeGB": 12.12,
             "kld": { "code": 0.0542, "prose": 0.0860, "reference": "Q8_0 of the same model" } },
  "kvCache": { "k": "q8_0", "v": "q8_0" },
  "spec": { "method": "mtp", "draftN": 2 },
  "observed": "2026-09-29",
  "recorded": "2026-10-05",
  "status": "measured",
  "results": [
    { "metric": "decode", "depth": 2236, "streams": 1, "basis": "per-stream", "value": 68.1, "confidence": "m" },
    { "metric": "decode", "depth": 98000, "streams": 1, "basis": "per-stream", "value": 27.7, "confidence": "m", "spec": "off" },
    { "metric": "prefill", "depth": 2000, "streams": 1, "basis": "per-stream", "value": 786.8, "confidence": "m", "prefillBasis": "cold" }
  ],
  "provenance": { "kind": "first-party", "attestation": "witnessed", "source": "repo path or issue", "digest": "sha256:…" }
}
```

What the validator holds you to, and why:

- **Only observations.** Confidence is `m` (measured, primary source) or `m~`
  (measured, secondary or anecdotal). There is no code for an estimate because
  an estimate has no place in the ledger.
- **Dates.** `recorded` (required) is when the reading entered this page — the
  latest it could have been observed. `observed` is the source's own date, when
  it gave one. Readings are lagging indicators of one stack at one time; the
  date is what lets a reader discount them.
- **Every point states its depth**, its stream count and its basis. For a cold
  prefill the depth is the prompt length. Where the source did not say, `depth`
  is `null` and `depthNote` says what it did say; such a decode reading is
  compared with the empty-context ceiling, so its share is a floor.
  `aggregate` is a total across streams and needs `streams > 1`. Give either
  `value` or a `range`, never both.
- **Prefill says what it covered**: `cold` (the whole prompt) or `new-tokens`
  (only tokens not already cached).
- **Speculation is stated.** A `spec: "off"` point is the clean reading at depth.
  Speculative decoding (MTP, DFlash, a draft model) belongs here because it is
  lossless: the target model verifies every token, so the output is what it
  would have produced anyway. Speculative prefill is not. It drops prompt
  tokens the draft judges unimportant (oMLX's SpecPrefill with `keep_pct 0.5`
  keeps half), so the model answers a shorter prompt and its "prefill" rate
  counts tokens it never read. Leave those runs out.
- **The model is named, or its absence is explained.** `model` is a key in
  `MODELS`, or `null` with a `modelNote` quoting what the source did call it.
  Where the source gives only a size ("a dense 40B"), `modelParams`
  (`{ "total": 40e9, "active"?: …, "note": "…" }`, allowed only with a null
  `model`) buys a weights-only bound: it leaves out the cache, so it sits above
  the true ceiling and the page says so.
- **The weights are described.** `quant.format` as the source names it ("not
  recorded" is an honest value); `quant.key` names the family in
  `WEIGHT_FORMATS` (`assets/ceiling.js`) so the ceiling knows the matrix
  precision and a typical width; `quant.bpw` when the line knows its real width.
- **Multi-card lines should say how they split** (`parallel.mode`: `tensor`
  or `layer`). Without it there is no single ceiling, and the page says so. This
  is a warning, not a failure, because many sources never say; a single-card
  line that states a split is rejected.
- **Provenance is declared, and the question is vouching, not typing.** `kind`
  is `first-party`, `issue-report` (GitHub issue, PR or discussion), `forum`,
  `review` (independent articles, benchmark sites and benchmark repositories) or
  `vendor`. `attestation` is the maintainer's own word: `witnessed` means they
  personally saw this hardware produce these numbers; `reported` is someone
  else's account, included because nothing gives a specific reason to doubt it.
  Where there is a specific reason, leave the number out rather than marking
  it. Only `first-party` can be `witnessed`. An `issue-report` or `forum` post
  must say whether anyone reproduced it.
- **A line that produced invalid numbers is `withdrawn`**, with the reason in
  `hazards`, rather than deleted or left looking measured.

`kld` is the KL divergence of the quant against a stated reference, on code and
on prose. It is quality, which tok/s is not: compare speed across lines only
where quality is comparable.

`kvCache.kibPerToken`, where measured, is held against the config-derived figure
by `tools/test-kv.mjs`. The derived figure is a lower bound on any engine's real
cost (drafters, workspaces and padding add to it).

## Candidates

`candidates` are rigs under consideration with no measured line yet: units, an
`interconnect`, the models they are meant to serve, and a note. Price and
capacity are derived from their units; the page shows each listed model's fit
and decode ceiling at the calculator's current settings. Leave `interconnect`
fields out rather than guessing; absent means nobody has looked.

`interconnect` can carry the vendor's numbers: `linksPerGpu`,
`peakP2pGBsPerGpu` (peak GPU-to-GPU bandwidth per GPU, both directions summed)
and `hostLinkGBs`. All are ratings, not measurements, and any of them needs a
`source`. A vendor that does not state GB/s gets no number. `costUsd` prices the
bridge or carrier board, which belongs to no card, plus parts an SXM carrier
cannot run without (cables, heatsinks, its power supply) when the note itemises
them; `costHighUsd` records the top of an observed range.

Peer bandwidth does not set single-stream decode under a layer split, which
follows one card's memory bandwidth. It decides how close tensor parallel gets
to its ceiling, and matters for prefill, concurrent streams, and anything
streamed from host RAM.

## What the checks catch

`tools/validate.mjs` enforces the schema plus what a schema cannot see:
duplicate ids, units naming unknown generations, rated figures that contradict
their generation, generation claims no source supports, overrides without a
reason, specifications without sources, lines naming models with no shape,
readings with no depth and no explanation, dates out of order, and the
provenance rules above; it warns on multi-card lines with no split.
`tools/test-ceilings.mjs` holds the ceiling arithmetic to hand-worked cases. `tools/test-validate.mjs` breaks the data dozens of ways and asserts each
is caught, and that the legitimate edge cases are still accepted.

`tools/check-ceilings.mjs` holds every reading to its own ceiling.
`tools/smoke.mjs` loads the real page in Chromium, drives every control and
asserts the tables and charts match the data. `tools/coverage.mjs` prints what
the catalog is missing; it never fails.

## Left out on purpose

Figures the old page carried that are deliberately not readings here:

- **gpt-oss-120B's ~24K-token prefill peak.** The old page coded it as an
  estimate, and an estimate has no place in the ledger.
- **Ratios without absolutes.** JarvisLabs' 1.73× MTP decode gain on the RTX PRO
  6000, and one source's +48% (2-way NVLink) and +8–10% (4-way) over PCIe-only,
  survive only as notes on the lines they qualify: a ratio with no measured
  baseline cannot be held to a ceiling.
- **Modelled performance tables** (the old `platforms[].perf` and `builds`
  estimates). Their measured figures became readings; the modelled ones did
  not, because the ceilings now do that job from the hardware's own specs.
