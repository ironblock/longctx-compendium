# Editing the data

Everything the page renders lives in [`compendium.json`](./compendium.json).
Nothing is duplicated into the HTML or the JavaScript, and anything that can be
computed is computed rather than stored: build cost and power draw are summed
from the units a build contains, and tokens/sec per watt, per $1,000,
wall-clock, and the confidence tallies in the honesty banner are all derived at
render time. Nothing on the page can disagree with the data behind it.

After any edit:

```sh
node tools/validate.mjs        # schema + cross-record checks
```

## Adding a device

Append one object to `platforms`. Only `id` and `display` are required — a
device with nothing else renders as a row of em dashes and fills in over time.

```json
{
  "id": "some_card",
  "display": {
    "label": "Full Name For Table Rows (48 GB)",
    "short": "ShortName",
    "color": "#7ec8ff",
    "group": "NVIDIA"
  }
}
```

`group` sections the tables (`NVIDIA`, `AMD`, `Unified`, `Value`, or a new one).
`color` must be unique across all records and is what identifies the device in
every chart.

Then fill in whatever you have:

```json
{
  "id": "some_card",
  "display": { "…": "…" },

  "hardware": {
    "vendor": "NVIDIA",
    "released": "2025-04",
    "memoryGB": 48,
    "memoryBandwidthGBs": 1008,
    "tdpW": 300,
    "process": "TSMC 4N",
    "compute": {
      "unit": "Tops",
      "source": "https://en.wikipedia.org/wiki/…",
      "values": { "fp32": 91.1, "bf16": 362.1, "fp8": 724.2, "fp8:sparse": 1448.4 }
    }
  },

  "pricing": {
    "msrp":   { "usd": 4500, "asOf": "2025-04" },
    "street": { "usd": 6200, "asOf": "2026-07", "note": "memory-shortage inflated" }
  },

  "power": { "loadW": 285, "idleW": 22, "confidence": "m", "note": "wall draw, capped at 300W" },

  "perf": {
    "moe": {
      "note": "llama.cpp Vulkan Q4_K_XL, Qwen3.5-35B-A3B",
      "prefill": { "512": [3100, "m"], "4096": [2900, "m"], "32768": [2100, "e"] },
      "decode":  { "short": [142.0, "m"], "at32k": [96.4, "m"] }
    }
  }
}
```

## Builds are compositions, not totals

Nothing that can be derived is stored. A build declares the **units** it
contains; its cost, load draw, and idle draw are summed from them at render
time. Correct one card's street price and every rig containing it moves.

```json
"builds": [
  {
    "id": "b_3090",
    "display": { "label": "4× RTX 3090 (96GB)", "short": "4× 3090", "color": "#4fc3f7" },
    "units": [{ "platform": "rtx3090", "count": 4 }],
    "host": { "costUsd": 800, "loadW": 90, "idleW": 25, "note": "EPYC chassis + PSU" }
  }
]
```

Reference a `platform` when the unit is one of the benchmarked devices. When it
is not — a card that appears only inside a rig — describe it inline instead:

```json
"units": [{
  "label": "RTX 3090 24GB",
  "count": 4,
  "pricing": { "street": { "usd": 1200, "asOf": "2026-07" } },
  "power":   { "loadW": 250, "idleW": 40, "confidence": "i" }
}]
```

`host` is for whatever the units do not account for — chassis, CPU, PSU,
cooling. It exists so the residual stays visible rather than getting smuggled
into a card price. The four-card PG199 entry is described in its source as
"~$6,000 + host", and that "+ host" belongs here once someone prices it.

A build with exactly one unit of one platform, and no `decode` of its own,
inherits that platform's decode rate — one card performs like one card.
Everything else states its own, because a four-card rig does not decode four
times as fast.

### `power` is not `hardware.tdpW`

`power.loadW` is the draw **observed under LLM inference**, per unit. It is
deliberately not the datasheet TDP: inference is bandwidth-bound and does not
reach the compute ceiling, and these cards are routinely power-capped. Summing
TDPs would overstate a 4× 3090 rig by about 40% and reshuffle the efficiency
rankings. Keep the datasheet figure in `hardware.tdpW` if you want it recorded;
nothing derives from it.

### A caveat about granularity

The platform records are not all the same kind of thing. `pro6000`, `rtx5090`,
`r9700` and `pg199` are single cards; `m3ultra`, `strixhalo` and `dgxspark` are
whole machines; and `v100` and `b70` are *already* four-card aggregates — their
labels say "×4" and their benchmarks were run on four cards. So `b_v100` is one
unit of an already-quadrupled platform, while `b_pg199` is four units of a
single card.

That inconsistency is inherited, not introduced, and the composition model
works either way — if `v100` is ever split into a single-card record, its build
becomes `count: 4` and the totals stay correct.

## Measurements and confidence

Any number that came from a benchmark is written as `[value, confidence]`:

| code | meaning |
|---|---|
| `m`  | measured, primary source |
| `m~` | measured, but secondary or anecdotal |
| `e`  | extrapolated from measured points |
| `i`  | modeled from specifications only |

There is deliberately **no code for "no data"** — leave the key out. An absent
context length is a gap in the chart; a zero would be a lie.

When a number needs provenance, use the long form instead:

```json
"512": { "value": 7640, "confidence": "m", "source": "llm-tracker.info", "note": "Q4_K_M" }
```

Specifications and prices are plain numbers — they are datasheet facts, not
benchmarks, so they carry a `source` or `asOf` on their block rather than a
confidence code.

## Adding data points, not devices

**A context length for one device** — add the key. It must already exist in
`meta.contexts`:

```json
"prefill": { "512": [3100, "m"], "131072": [880, "e"] }
```

**A context length for everyone** — add it to `meta.contexts`. A column appears
in the prefill table and a point on the x-axis; devices without that key show
gaps.

```json
{ "tokens": 262144, "label": "256K" }
```

**A precision** — add a key under `hardware.compute.values`. A column appears in
the specifications table automatically. Suffix with `:sparse` for
structured-sparsity figures.

**A price kind** — add a key under `pricing`. `msrp` and `street` are rendered
today; anything else is stored and ignored until something renders it.

**A model archetype** — add it to `meta.archetypes`, then add a matching key
under each device's `perf`. Note that the archetype toggle buttons and the
value-section anchors are still spelled out in `index.html`, so a fourth
archetype needs a button added there too.

## Devices that cannot run something

Missing data and *impossible* are different, and the distinction is worth
keeping:

```json
"oss120b": { "note": "32GB — cannot fit 120B (~63GB)", "unsupported": true }
```

An archetype entry with neither data nor `unsupported: true` is rejected — an
empty block is almost always a half-finished edit.

## Stashing data you have not decided how to show

`extra` is an open object on any record. Nothing reads it, the schema permits
anything inside it, and it exists so a half-researched figure has somewhere to
live that is not a comment (JSON has none) or a dropped browser tab.

```json
"extra": { "pcieGen": 5, "nvlink": false, "notesToSelf": "recheck idle draw" }
```

## What the checks catch

`tools/validate.mjs` enforces the schema plus the things a schema cannot see:
duplicate ids, colour collisions between unrelated devices, prefill keys that
are not on the context axis, archetypes not declared in `meta`, build units
pointing at platforms that do not exist or that lack the price and power a
build's totals are summed from, and archetype entries that are empty for no
stated reason.

`tools/test-validate.mjs` breaks the data nineteen different ways and asserts
each one is caught, so the validator cannot quietly stop working.

`tools/smoke.mjs` loads the real page in Chromium, clicks every toggle, and
asserts the charts actually painted — the one check that catches data which
validates cleanly but throws during render.
