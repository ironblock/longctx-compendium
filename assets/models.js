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
//   params.total     every weight that has to be resident, excluding vision
//                    towers and MTP heads, which a text decode does not run
//   params.active    weights read per decoded token (all of them, for dense)
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
      quote: "- Number of Parameters: 27B"
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
    note: "Dense in weights but hybrid in attention: 48 Gated DeltaNet layers to 16 full-attention ones. The count excludes the vision tower and the MTP head."
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
      quote: "- Number of Parameters: 125B with 6B activated, plus 51B n-gram embedding and 4B MTP"
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
    note: "The 12 layers the config calls full attention are block-sparse (Qwen Sparse Attention): an indexer picks at most 2,048 positions per step, so decode reads that many while the cache still holds every position; the indexer's own compressed keys, which it scans across every position, are not counted. The count excludes a 51B n-gram embedding, which the program that measures this model keeps in host RAM (so host RAM is a capacity spec for it), and a 4B MTP head. Two KV heads: a 4-way tensor-parallel split must replicate them."
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
      quote: "- Number of Parameters: 27B"
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
      quote: "- Number of Parameters: 27B"
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
      quote: "- Number of Parameters: 35B in total and 3B activated"
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
      quote: "- Number of Parameters: 35B in total and 3B activated"
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
      quote: "- Number of Parameters: 9B"
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
      quote: "- Number of Parameters: 80B in total and 3B activated"
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
    note: "The count excludes the 1.65B MTP head the checkpoint also carries."
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
      quote: "- Number of Parameters: 80B in total and 3B activated"
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
      quote: "The model has 3.5B active parameters and 30B parameters in total."
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
      quote: "| **Total Parameters** | 2.3B effective <br> (5.1B with embeddings) | 4.5B effective <br> (8B with embeddings) | 11.95B | 30.7B |"
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
      quote: "(117B parameters with 5.1B active parameters)"
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
      quote: "GLM-4.7-Flash is a 30B-A3B MoE model."
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
    note: "Multi-head latent attention: each position caches a 512-wide latent and a 64-wide rotary key, shared by every head. The active count is only the card's nominal \"A3B\"."
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
      quote: "- Number of Parameters: 30.5B in total and 3.3B activated"
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
      quote: "- Number of Parameters: 30.5B in total and 3.3B activated"
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
      quote: "- Number of Parameters: 32.8B"
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
      quote: "- Number of Parameters: 32.5B"
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
      quote: "Mistral Small 3 ( 2501 ) sets a new benchmark in the \"small\" Large Language Models category below 70B, boasting 24B parameters and achieving state-of-the-art capabilities comparable to larger models!"
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
      quote: "The Meta Llama 3.3 multilingual large language model (LLM) is a pretrained and instruction tuned generative model in 70B (text in/text out)."
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
      quote: "The Meta Llama 3.1 collection of multilingual large language models (LLMs) is a collection of pretrained and instruction tuned generative models in 8B, 70B and 405B sizes (text in/text out)."
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
      quote: "We open-source distilled 1.5B, 7B, 8B, 14B, 32B, and 70B checkpoints based on Qwen2.5 and Llama3 series to the community."
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
      quote: "- Number of Parameters: 3.09B"
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
