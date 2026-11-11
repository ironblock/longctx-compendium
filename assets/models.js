// The shape of every model this page computes a ceiling for or records a
// reading of. Facts about MODELS, kept apart from data/compendium.json, which
// holds facts about hardware and what it was seen to do.
//
// Transcribed on 2026-10-14 from each model's published config.json (`source`,
// pinned to the repo commit in `revision`) and its model card or checkpoint
// headers (`params.source`), not recalled. Layer types are counted from the
// config's own layer_types list (or its explicit pattern fields), so a model
// that breaks the pattern cannot slip through as "every fourth layer".
//
//   params.total     every weight the main decode pass keeps in GPU memory:
//                    excluding vision towers, MTP heads and lookup tables, which
//                    are counted apart (below)
//   params.active    weights read per decoded token (all of them, for dense)
//   params.mtp       the checkpoint's multi-token-prediction head, summed from
//                    its safetensors headers (0: the checkpoint carries none).
//                    Resident only when speculative decoding uses it
//   params.lookup, params.lookupBits
//                    n-gram / Engram-style tables read by lookup, a few rows per
//                    token: a capacity cost, placed in host RAM, not bandwidth
//   params.split     where mtp and lookup were counted
//   params.inputEmbedding, params.tiedEmbeddings
//                    vocab x hidden from the same config. A decode step reads one
//                    row of an untied input embedding, so ceilings take it out of
//                    the bytes and FLOPs per token; a tied one is read in full as
//                    the output head, so it stays in
//   layerTypes       full_attention / sliding_attention / linear_attention /
//                    ffn_only -- how many of each; they sum to `layers`
//   heads, kvHeads, headDim
//                    attention shape; `attention.full` / `.sliding` override
//                    it per layer type where a model uses two shapes
//   mla              multi-head latent attention: one compressed latent per
//                    position instead of per-head keys and values
//   sparse.budget    positions a block-sparse "full" layer reads per step
//   linear           recurrent-state shape of the linear-attention layers
//
// assets/ceiling.js turns these into bytes and FLOPs; tools/test-kv.mjs holds
// the cache arithmetic against what first-party lines actually measured.

export const MODELS = {
  qwen38_27b: {
    label: "Qwen3.8-27B",
    repo: "Qwen/Qwen3.8-27B",
    source: "https://huggingface.co/Qwen/Qwen3.8-27B/raw/main/config.json",
    revision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
    params: {
      total: 26895998464,
      active: 26895998464,
      source: "https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/README.md",
      quote: "- Number of Parameters: 27B",
      inputEmbedding: 1271398400,
      tiedEmbeddings: false,
      mtp: 424699392,
      split: "safetensors headers of Qwen/Qwen3.8-27B at 1d4bf0f2ff60: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 64,
    layerTypes: {
      full_attention: 16,
      linear_attention: 48
    },
    heads: 24,
    kvHeads: 4,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 48,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    maxPositions: 262144,
    note: "Dense in weights but hybrid in attention: 48 Gated DeltaNet layers to 16 full-attention ones. The count excludes the vision tower and the 0.42B MTP head (params.mtp)."
  },
  qwen38_flash_next: {
    label: "Qwen3.8-Flash-Next",
    repo: "Qwen/Qwen3.8-Flash-Next",
    source: "https://huggingface.co/Qwen/Qwen3.8-Flash-Next/raw/main/config.json",
    revision: "de4b8e4d43b917e7706784d8bb445c9af86a3540",
    params: {
      total: 125000000000,
      active: 6000000000,
      source: "https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/main/README.md",
      quote: "- Number of Parameters: 125B with 6B activated, plus 51B n-gram embedding and 4B MTP",
      inputEmbedding: 635699200,
      tiedEmbeddings: false,
      mtp: 2607150848,
      lookup: 51200245792,
      lookupBits: 16,
      split: "safetensors headers of Qwen/Qwen3.8-Flash-Next at de4b8e4d43b9: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 48,
    layerTypes: {
      full_attention: 12,
      linear_attention: 36
    },
    heads: 24,
    kvHeads: 2,
    headDim: 256,
    sparse: {
      budget: 2048
    },
    linear: {
      kind: "gated-deltanet",
      valueHeads: 48,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    moe: {
      experts: 512,
      expertsPerToken: 10,
      shared: 1
    },
    maxPositions: 262144,
    note: "The 12 layers the config calls full attention are block-sparse (Qwen Sparse Attention): an indexer picks at most 2,048 positions per step, so decode reads that many while the cache still holds every position; the indexer's own compressed keys, which it scans across every position, are not counted. The count excludes the n-gram embedding (51.2B in BF16, params.lookup), which the program that measures this model keeps in host RAM, and the MTP head. The card's \"4B MTP\" is more than the 2.61B of mtp.* tensors in the checkpoint, an MoE layer with all 512 experts; this page guesses the card also counts the input embedding and output head the head shares (2 x 0.64B), which would make 3.88B. Two KV heads: a 4-way tensor-parallel split must replicate them."
  },
  qwen36_27b: {
    label: "Qwen3.6-27B",
    repo: "Qwen/Qwen3.6-27B",
    source: "https://huggingface.co/Qwen/Qwen3.6-27B/raw/main/config.json",
    revision: "6a9e13bd6fc8f0983b9b99948120bc37f49c13e9",
    params: {
      total: 26895998464,
      active: 26895998464,
      source: "https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/README.md",
      quote: "- Number of Parameters: 27B",
      inputEmbedding: 1271398400,
      tiedEmbeddings: false,
      mtp: 424699392,
      split: "safetensors headers of Qwen/Qwen3.6-27B at 6a9e13bd6fc8: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 64,
    layerTypes: {
      full_attention: 16,
      linear_attention: 48
    },
    heads: 24,
    kvHeads: 4,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 48,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    maxPositions: 262144,
    note: "Dense in weights but hybrid in attention: 48 Gated DeltaNet layers to 16 full-attention ones. Same tensors as Qwen3.8-27B."
  },
  qwen35_27b: {
    label: "Qwen3.5-27B",
    repo: "Qwen/Qwen3.5-27B",
    source: "https://huggingface.co/Qwen/Qwen3.5-27B/raw/main/config.json",
    revision: "fc05daec18b0a78c049392ed2e771dde82bdf654",
    params: {
      total: 26895998464,
      active: 26895998464,
      source: "https://huggingface.co/Qwen/Qwen3.5-27B/blob/main/README.md",
      quote: "- Number of Parameters: 27B",
      inputEmbedding: 1271398400,
      tiedEmbeddings: false,
      mtp: 424699392,
      split: "safetensors headers of Qwen/Qwen3.5-27B at fc05daec18b0: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 64,
    layerTypes: {
      full_attention: 16,
      linear_attention: 48
    },
    heads: 24,
    kvHeads: 4,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 48,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    maxPositions: 262144,
    note: "Dense in weights but hybrid in attention: 48 Gated DeltaNet layers to 16 full-attention ones."
  },
  qwen36_35b_a3b: {
    label: "Qwen3.6-35B-A3B",
    repo: "Qwen/Qwen3.6-35B-A3B",
    source: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/config.json",
    revision: "995ad96eacd98c81ed38be0c5b274b04031597b0",
    params: {
      total: 34660610688,
      active: 3000000000,
      source: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/README.md",
      quote: "- Number of Parameters: 35B in total and 3B activated",
      inputEmbedding: 508559360,
      tiedEmbeddings: false,
      mtp: 844640768,
      split: "safetensors headers of Qwen/Qwen3.6-35B-A3B at 995ad96eacd9: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 40,
    layerTypes: {
      full_attention: 10,
      linear_attention: 30
    },
    heads: 16,
    kvHeads: 2,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 32,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    moe: {
      experts: 256,
      expertsPerToken: 8,
      shared: 1
    },
    maxPositions: 262144,
    note: "Hybrid MoE: 30 Gated DeltaNet layers to 10 full-attention ones."
  },
  qwen35_35b_a3b: {
    label: "Qwen3.5-35B-A3B",
    repo: "Qwen/Qwen3.5-35B-A3B",
    source: "https://huggingface.co/Qwen/Qwen3.5-35B-A3B/raw/main/config.json",
    revision: "59d61f3ce65a6d9863b86d2e96597125219dc754",
    params: {
      total: 34660610688,
      active: 3000000000,
      source: "https://huggingface.co/Qwen/Qwen3.5-35B-A3B/blob/main/README.md",
      quote: "- Number of Parameters: 35B in total and 3B activated",
      inputEmbedding: 508559360,
      tiedEmbeddings: false,
      mtp: 844640768,
      split: "safetensors headers of Qwen/Qwen3.5-35B-A3B at 59d61f3ce65a: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 40,
    layerTypes: {
      full_attention: 10,
      linear_attention: 30
    },
    heads: 16,
    kvHeads: 2,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 32,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    moe: {
      experts: 256,
      expertsPerToken: 8,
      shared: 1
    },
    maxPositions: 262144,
    note: "Hybrid MoE: 30 Gated DeltaNet layers to 10 full-attention ones."
  },
  qwen35_9b: {
    label: "Qwen3.5-9B",
    repo: "Qwen/Qwen3.5-9B",
    source: "https://huggingface.co/Qwen/Qwen3.5-9B/raw/main/config.json",
    revision: "c202236235762e1c871ad0ccb60c8ee5ba337b9a",
    params: {
      total: 8953803264,
      active: 8953803264,
      source: "https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/README.md",
      quote: "- Number of Parameters: 9B",
      inputEmbedding: 1017118720,
      tiedEmbeddings: false,
      mtp: 243290624,
      split: "safetensors headers of Qwen/Qwen3.5-9B at c20223623576: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 32,
    layerTypes: {
      full_attention: 8,
      linear_attention: 24
    },
    heads: 16,
    kvHeads: 4,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 32,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    maxPositions: 262144,
    note: "Hybrid: 24 Gated DeltaNet layers to 8 full-attention ones."
  },
  qwen3_next_80b_a3b: {
    label: "Qwen3-Next-80B-A3B-Instruct",
    repo: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    source: "https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct/raw/main/config.json",
    revision: "9c7f2fbe84465e40164a94cc16cd30b6999b0cc7",
    params: {
      total: 79674391296,
      active: 3000000000,
      source: "https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct/blob/main/README.md",
      quote: "- Number of Parameters: 80B in total and 3B activated",
      inputEmbedding: 311164928,
      tiedEmbeddings: false,
      mtp: 1650471424,
      split: "safetensors headers of Qwen/Qwen3-Next-80B-A3B-Instruct at 9c7f2fbe8446: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 48,
    layerTypes: {
      full_attention: 12,
      linear_attention: 36
    },
    heads: 16,
    kvHeads: 2,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 32,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    moe: {
      experts: 512,
      expertsPerToken: 10,
      shared: 1
    },
    maxPositions: 262144,
    note: "The count excludes the 1.65B MTP head the checkpoint also carries (params.mtp)."
  },
  qwen3_coder_next_80b_a3b: {
    label: "Qwen3-Coder-Next",
    repo: "Qwen/Qwen3-Coder-Next",
    source: "https://huggingface.co/Qwen/Qwen3-Coder-Next/raw/main/config.json",
    revision: "a7fbcb5c0e12d62a448eaa0e260346bf5dcc0feb",
    params: {
      total: 79674391296,
      active: 3000000000,
      source: "https://huggingface.co/Qwen/Qwen3-Coder-Next/blob/main/README.md",
      quote: "- Number of Parameters: 80B in total and 3B activated",
      inputEmbedding: 311164928,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen3-Coder-Next at a7fbcb5c0e12: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 48,
    layerTypes: {
      full_attention: 12,
      linear_attention: 36
    },
    heads: 16,
    kvHeads: 2,
    headDim: 256,
    linear: {
      kind: "gated-deltanet",
      valueHeads: 32,
      keyHeads: 16,
      keyHeadDim: 128,
      valueHeadDim: 128
    },
    moe: {
      experts: 512,
      expertsPerToken: 10,
      shared: 1
    },
    maxPositions: 262144,
    note: "Published as Qwen/Qwen3-Coder-Next. Identical tensor names and shapes to Qwen3-Next-80B-A3B; only the RoPE base differs, and it ships no MTP head."
  },
  nemotron3_nano_30b_a3b: {
    label: "Nemotron-3-Nano-30B-A3B",
    repo: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    source: "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/raw/main/config.json",
    revision: "bf77c3174f68ad409e1c2aa60daeb46e32d1c606",
    params: {
      total: 31577940288,
      active: 3500000000,
      source: "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/blob/main/README.md",
      quote: "The model has 3.5B active parameters and 30B parameters in total.",
      inputEmbedding: 352321536,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 at bf77c3174f68: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 52,
    layerTypes: {
      full_attention: 6,
      linear_attention: 23,
      ffn_only: 23
    },
    heads: 32,
    kvHeads: 2,
    headDim: 128,
    linear: {
      kind: "mamba2",
      valueHeads: 64,
      keyHeadDim: 128,
      valueHeadDim: 64
    },
    moe: {
      experts: 128,
      expertsPerToken: 6,
      shared: 1
    },
    maxPositions: 262144,
    note: "52 blocks: 23 Mamba-2, 23 MoE-only and 6 attention. Only the 6 hold a KV cache."
  },
  gemma4_31b: {
    label: "Gemma-4-31B",
    repo: "google/gemma-4-31B-it",
    source: "https://huggingface.co/google/gemma-4-31B-it/raw/main/config.json",
    revision: "842da3794eaa0b77d5f08bae87a17459d91ff475",
    params: {
      total: 30700000000,
      active: 30700000000,
      source: "https://huggingface.co/google/gemma-4-31B-it/blob/main/README.md",
      quote: "| **Total Parameters** | 2.3B effective <br> (5.1B with embeddings) | 4.5B effective <br> (8B with embeddings) | 11.95B | 30.7B |",
      inputEmbedding: 1409286144,
      tiedEmbeddings: true,
      mtp: 0,
      split: "safetensors headers of google/gemma-4-31B-it at 842da3794eaa: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 60,
    layerTypes: {
      full_attention: 10,
      sliding_attention: 50
    },
    slidingWindow: 1024,
    heads: 32,
    kvHeads: 16,
    headDim: 256,
    attention: {
      full: {
        heads: 32,
        kvHeads: 4,
        headDim: 512,
        keysEqualValues: true
      },
      sliding: {
        heads: 32,
        kvHeads: 16,
        headDim: 256
      }
    },
    maxPositions: 262144,
    note: "Full-attention layers use 4 KV heads of 512 and one shared projection for keys and values, cached once here; sliding layers use 16 KV heads of 256 over a 1,024-token window."
  },
  gpt_oss_120b: {
    label: "gpt-oss-120b",
    repo: "openai/gpt-oss-120b",
    source: "https://huggingface.co/openai/gpt-oss-120b/raw/main/config.json",
    revision: "b5c939de8f754692c1647ca79fbf85e8c1e70f8a",
    params: {
      total: 117000000000,
      active: 5100000000,
      source: "https://huggingface.co/openai/gpt-oss-120b/blob/main/README.md",
      quote: "(117B parameters with 5.1B active parameters)",
      inputEmbedding: 579133440,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of openai/gpt-oss-120b at b5c939de8f75: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 36,
    layerTypes: {
      full_attention: 18,
      sliding_attention: 18
    },
    slidingWindow: 128,
    heads: 64,
    kvHeads: 8,
    headDim: 64,
    moe: {
      experts: 128,
      expertsPerToken: 4,
      shared: 0
    },
    maxPositions: 131072,
    note: "Experts are MXFP4; attention, router, embeddings and output head stay BF16, so a ceiling computed at one width throughout is higher than the true one. Sliding-window (128) and full-attention layers alternate."
  },
  glm47_flash: {
    label: "GLM-4.7-Flash",
    repo: "zai-org/GLM-4.7-Flash",
    source: "https://huggingface.co/zai-org/GLM-4.7-Flash/raw/main/config.json",
    revision: "7dd20894a642a0aa287e9827cb1a1f7f91386b67",
    params: {
      total: 29943393920,
      active: 3000000000,
      source: "https://huggingface.co/zai-org/GLM-4.7-Flash/blob/main/README.md",
      quote: "GLM-4.7-Flash is a 30B-A3B MoE model.",
      inputEmbedding: 317194240,
      tiedEmbeddings: false,
      mtp: 1278094656,
      split: "safetensors headers of zai-org/GLM-4.7-Flash at 7dd20894a642: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 47,
    layerTypes: {
      full_attention: 47
    },
    heads: 20,
    kvHeads: 20,
    headDim: 256,
    mla: {
      kvLoraRank: 512,
      ropeDim: 64,
      qkNopeDim: 192,
      vHeadDim: 256
    },
    moe: {
      experts: 64,
      expertsPerToken: 4,
      shared: 1
    },
    maxPositions: 202752,
    note: "Multi-head latent attention: each position caches a 512-wide latent and a 64-wide rotary key, shared by every head. The active count is only the card's nominal \"A3B\". Its MTP layer (layer 47, 1.28B) stores its own copies of the input embedding and output head, 0.63B of the 1.28B; an engine that shares them with the main model holds 0.64B."
  },
  qwen3_30b_a3b: {
    label: "Qwen3-30B-A3B",
    repo: "Qwen/Qwen3-30B-A3B",
    source: "https://huggingface.co/Qwen/Qwen3-30B-A3B/raw/main/config.json",
    revision: "ad44e777bcd18fa416d9da3bd8f70d33ebb85d39",
    params: {
      total: 30500000000,
      active: 3300000000,
      source: "https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/README.md",
      quote: "- Number of Parameters: 30.5B in total and 3.3B activated",
      inputEmbedding: 311164928,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen3-30B-A3B at ad44e777bcd1: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 48,
    layerTypes: {
      full_attention: 48
    },
    heads: 32,
    kvHeads: 4,
    headDim: 128,
    moe: {
      experts: 128,
      expertsPerToken: 8,
      shared: 0
    },
    maxPositions: 40960
  },
  qwen3_coder_30b_a3b: {
    label: "Qwen3-Coder-30B-A3B-Instruct",
    repo: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    source: "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/config.json",
    revision: "b2cff646eb4bb1d68355c01b18ae02e7cf42d120",
    params: {
      total: 30500000000,
      active: 3300000000,
      source: "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/blob/main/README.md",
      quote: "- Number of Parameters: 30.5B in total and 3.3B activated",
      inputEmbedding: 311164928,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen3-Coder-30B-A3B-Instruct at b2cff646eb4b: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 48,
    layerTypes: {
      full_attention: 48
    },
    heads: 32,
    kvHeads: 4,
    headDim: 128,
    moe: {
      experts: 128,
      expertsPerToken: 8,
      shared: 0
    },
    maxPositions: 262144
  },
  qwen3_32b: {
    label: "Qwen3-32B",
    repo: "Qwen/Qwen3-32B",
    source: "https://huggingface.co/Qwen/Qwen3-32B/raw/main/config.json",
    revision: "9216db5781bf21249d130ec9da846c4624c16137",
    params: {
      total: 32800000000,
      active: 32800000000,
      source: "https://huggingface.co/Qwen/Qwen3-32B/blob/main/README.md",
      quote: "- Number of Parameters: 32.8B",
      inputEmbedding: 777912320,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen3-32B at 9216db5781bf: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 64,
    layerTypes: {
      full_attention: 64
    },
    heads: 64,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 40960
  },
  qwen25_32b: {
    label: "Qwen2.5-32B-Instruct",
    repo: "Qwen/Qwen2.5-32B-Instruct",
    source: "https://huggingface.co/Qwen/Qwen2.5-32B-Instruct/raw/main/config.json",
    revision: "5ede1c97bbab6ce5cda5812749b4c0bdf79b18dd",
    params: {
      total: 32500000000,
      active: 32500000000,
      source: "https://huggingface.co/Qwen/Qwen2.5-32B-Instruct/blob/main/README.md",
      quote: "- Number of Parameters: 32.5B",
      inputEmbedding: 778567680,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen2.5-32B-Instruct at 5ede1c97bbab: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 64,
    layerTypes: {
      full_attention: 64
    },
    heads: 40,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 32768,
    note: "The card says 32.5B; the checkpoint holds 32.76B."
  },
  mistral_small_24b: {
    label: "Mistral-Small-24B-Instruct-2501",
    repo: "mistralai/Mistral-Small-24B-Instruct-2501",
    source: "https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501/raw/main/config.json",
    revision: "9527884be6e5616bdd54de542f9ae13384489724",
    params: {
      total: 23572403200,
      active: 23572403200,
      source: "https://huggingface.co/mistralai/Mistral-Small-24B-Instruct-2501/blob/main/README.md",
      quote: "Mistral Small 3 ( 2501 ) sets a new benchmark in the \"small\" Large Language Models category below 70B, boasting 24B parameters and achieving state-of-the-art capabilities comparable to larger models!",
      inputEmbedding: 671088640,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of mistralai/Mistral-Small-24B-Instruct-2501 at 9527884be6e5: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 40,
    layerTypes: {
      full_attention: 40
    },
    heads: 32,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 32768,
    note: "head_dim is 128 by config, not hidden size ÷ heads (160)."
  },
  llama33_70b: {
    label: "Llama-3.3-70B-Instruct",
    repo: "unsloth/Llama-3.3-70B-Instruct",
    source: "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/raw/main/config.json",
    revision: "99cd0d2c829e92a67c844f9144c2509632e5c87f",
    mirrorOf: "meta-llama/Llama-3.3-70B-Instruct",
    params: {
      total: 70553706496,
      active: 70553706496,
      source: "https://huggingface.co/unsloth/Llama-3.3-70B-Instruct/blob/main/README.md",
      quote: "The Meta Llama 3.3 multilingual large language model (LLM) is a pretrained and instruction tuned generative model in 70B (text in/text out).",
      inputEmbedding: 1050673152,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of unsloth/Llama-3.3-70B-Instruct at 99cd0d2c829e: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 80,
    layerTypes: {
      full_attention: 80
    },
    heads: 64,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 131072,
    note: "Read from the ungated unsloth mirror; the gated official repo reports the same parameter count."
  },
  llama2_7b: {
    label: "Llama-2-7B",
    repo: "NousResearch/Llama-2-7b-hf",
    source: "https://huggingface.co/NousResearch/Llama-2-7b-hf/raw/main/config.json",
    revision: "8efe6c9b93655b934e27bd9981e3ec13e55aee9d",
    mirrorOf: "meta-llama/Llama-2-7b-hf",
    params: {
      total: 6738415616,
      active: 6738415616,
      source: "https://huggingface.co/NousResearch/Llama-2-7b-hf/blob/main/README.md",
      quote: "Llama 2 is a collection of pretrained and fine-tuned generative text models ranging in scale from 7 billion to 70 billion parameters. This is the repository for the 7B pretrained model, converted for the Hugging Face Transformers format.",
      inputEmbedding: 131072000,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of NousResearch/Llama-2-7b-hf at 8efe6c9b9365: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 32,
    layerTypes: {
      full_attention: 32
    },
    heads: 32,
    kvHeads: 32,
    headDim: 128,
    maxPositions: 4096,
    note: "Read from the ungated NousResearch mirror. The total is the mirror's F16 count in its safetensors metadata, which the config's shape reproduces exactly; the 2,048 F32 values listed beside it are not weights. No grouped-query attention (32 KV heads for 32 query heads), so its cache grows four times faster per token than Llama-3.1-8B's, and it stops at 4,096 positions: it is here for llama.cpp's cross-GPU llama-bench scoreboards, not for long context."
  },
  llama31_8b: {
    label: "Llama-3.1-8B-Instruct",
    repo: "NousResearch/Meta-Llama-3.1-8B-Instruct",
    source: "https://huggingface.co/NousResearch/Meta-Llama-3.1-8B-Instruct/raw/main/config.json",
    revision: "d10aef7999a2b5ba950ab3974312feeedbfe0b77",
    mirrorOf: "meta-llama/Llama-3.1-8B-Instruct",
    params: {
      total: 8030261248,
      active: 8030261248,
      source: "https://huggingface.co/NousResearch/Meta-Llama-3.1-8B-Instruct/blob/main/README.md",
      quote: "The Meta Llama 3.1 collection of multilingual large language models (LLMs) is a collection of pretrained and instruction tuned generative models in 8B, 70B and 405B sizes (text in/text out).",
      inputEmbedding: 525336576,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of NousResearch/Meta-Llama-3.1-8B-Instruct at d10aef7999a2: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 32,
    layerTypes: {
      full_attention: 32
    },
    heads: 32,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 131072,
    note: "Read from the ungated NousResearch mirror; the gated official repo reports the same parameter count."
  },
  deepseek_r1_distill_llama_8b: {
    label: "DeepSeek-R1-Distill-Llama-8B",
    repo: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    source: "https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-8B/raw/main/config.json",
    revision: "6a6f4aa4197940add57724a7707d069478df56b1",
    params: {
      total: 8030261248,
      active: 8030261248,
      source: "https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-8B/blob/main/README.md",
      quote: "We open-source distilled 1.5B, 7B, 8B, 14B, 32B, and 70B checkpoints based on Qwen2.5 and Llama3 series to the community.",
      inputEmbedding: 525336576,
      tiedEmbeddings: false,
      mtp: 0,
      split: "safetensors headers of deepseek-ai/DeepSeek-R1-Distill-Llama-8B at 6a6f4aa41979: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 32,
    layerTypes: {
      full_attention: 32
    },
    heads: 32,
    kvHeads: 8,
    headDim: 128,
    maxPositions: 131072
  },
  qwen25_3b: {
    label: "Qwen2.5-3B-Instruct",
    repo: "Qwen/Qwen2.5-3B-Instruct",
    source: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/raw/main/config.json",
    revision: "aa8e72537993ba99e69dfaafa59ed015b17504d1",
    params: {
      total: 3090000000,
      active: 3090000000,
      source: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/README.md",
      quote: "- Number of Parameters: 3.09B",
      inputEmbedding: 311164928,
      tiedEmbeddings: true,
      mtp: 0,
      split: "safetensors headers of Qwen/Qwen2.5-3B-Instruct at aa8e72537993: tensors under mtp.* (or past the last decoder layer) and n-gram tables, summed shape by shape"
    },
    layers: 36,
    layerTypes: {
      full_attention: 36
    },
    heads: 16,
    kvHeads: 2,
    headDim: 128,
    maxPositions: 32768
  },
};

// Separate draft models for speculative decoding, keyed by id, each naming the
// model it drafts for. Same shape fields as MODELS, so the cache arithmetic in
// assets/ceiling.js applies; a drafter that shares its target's embedding and
// output head stores neither, and its total says so.
export const DRAFTERS = {
  qwen38_27b_dflash2: {
    label: "DFlash2 drafter for Qwen3.8-27B",
    for: "qwen38_27b",
    method: "dflash2",
    repo: "z-lab/Qwen3.8-27B-DFlash2",
    source: "https://huggingface.co/z-lab/Qwen3.8-27B-DFlash2/raw/main/config.json",
    revision: "50307d4c4cde6860d4eee73e2547cd786fe8e8a4",
    params: {
      total: 1924404480,
      active: 1924404480,
      source: "safetensors header of z-lab/Qwen3.8-27B-DFlash2 at 50307d4c4cde: five decoder layers, a fusion projection over five target layers' hidden states and a candidate selector, with no embedding or output head of its own",
      inputEmbedding: 0,
      tiedEmbeddings: false
    },
    layers: 5,
    layerTypes: {
      sliding_attention: 5
    },
    heads: 32,
    kvHeads: 8,
    headDim: 128,
    slidingWindow: 2048,
    note: "A block-diffusion drafter: \"Speculation block size: 8 (7 draft tokens per verification step)\" (model card). Its five layers attend over a 2,048-position window, so its own cache stays near 40 MB at F16 however deep the context. Re-uploaded unchanged as incoai/Qwen3.8-27B-DFlash2; the ledger also runs igor255's EXL3 4.00 bpw quant and Z-Lab's Q4_K_M GGUF (1,143,006,816 bytes)."
  },
};

