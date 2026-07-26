# Editing the data

Everything the page renders lives in [`compendium.json`](./compendium.json).
Nothing is duplicated into the HTML or the JavaScript, and no number is
computed ahead of time — tokens/sec per watt, per $1,000, wall-clock, and the
confidence tallies in the honesty banner are all derived at render time, so
they cannot disagree with the data.

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

  "system": { "buildCostUsd": 25400, "loadW": 1200, "idleW": 100 },

  "perf": {
    "moe": {
      "note": "llama.cpp Vulkan Q4_K_XL, Qwen3.5-35B-A3B",
      "prefill": { "512": [3100, "m"], "4096": [2900, "m"], "32768": [2100, "e"] },
      "decode":  { "short": [142.0, "m"], "at32k": [96.4, "m"] }
    }
  }
}
```

## `pricing` versus `system.buildCostUsd`

These look redundant and are not. `pricing` is what **one unit** costs — the
card, or the whole machine for something like a Mac Studio. It is where
MSRP-versus-street lives, and it is a fact about the device.
`system.buildCostUsd` is what the **assembled box** cost, and it is the number
the value tables divide by.

For a single-card build the two coincide. For a four-card rig they do not: in
the example above, one card streets at $6,200 and the four-card build totals
$25,400 including the host. Writing the rig total into `pricing.street` would
claim a single card costs $25,400.

Neither is derived from the other, because rig cost does not scale linearly —
hosts, cooling, and NVLink bridges are real money, and the four-card PG199 entry
is explicitly "~$6,000 + host". The only rule enforced is the one that is always
true: a rig cannot cost less than one of the units inside it.

`system` is present only on platforms that are themselves purchasable boxes.
Multi-card rigs with no single-platform equivalent live in `builds`, where the
build cost *is* the price, so they carry no `pricing` block at all.

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

## Standalone builds

`builds` holds multi-card rigs that are not any single platform: `4× RTX 3090`,
`A100 80GB`, `4× PG199`, `4× Arc B70`. They carry their own decode numbers
because a four-card rig does not perform like the card it is made of.

A platform that *is* a purchasable box gets a `system` block instead and is
folded into the value tables automatically. Add `buildShort` there when the
assembled rig is named differently from the bare card.

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
are not on the context axis, archetypes not declared in `meta`, a street price
that disagrees with the build cost it is supposed to equal, and archetype
entries that are empty for no stated reason.

`tools/test-validate.mjs` breaks the data fourteen different ways and asserts
each one is caught, so the validator cannot quietly stop working.

`tools/smoke.mjs` loads the real page in Chromium, clicks every toggle, and
asserts the charts actually painted — the one check that catches data which
validates cleanly but throws during render.
