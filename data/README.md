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

## The three collections

| collection | what it is | example |
|---|---|---|
| `units` | a purchasable piece of hardware — what a datasheet describes | one Tesla V100 SXM2 32GB |
| `platforms` | a benchmarked configuration, composed of units | `V100 NVLink ×4` = 4 units |
| `builds` | a box you could buy, composed of platforms or units | `4× V100 32GB (1CATai)` |

Prices, power draw, capacity and release dates live on **units**, once. A
platform or build says how many of what it contains, and its totals are summed
at render time. Correct one card's street price and every platform and rig
containing it moves with it.

## Adding a device

Append one object to `platforms`. Only `id`, `display` and `composition` are
required — a device with nothing else renders as a row of em dashes and fills
in over time.

First describe the hardware once, in `units`:

```json
{
  "id": "some_card",
  "label": "Some Accelerator 48GB",
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
  },
  "pricing": {
    "msrp":   { "usd": 4500, "asOf": "2025-04" },
    "street": { "usd": 6200, "asOf": "2026-07", "note": "memory-shortage inflated" }
  },
  "power": { "loadW": 285, "idleW": 22, "confidence": "m", "note": "wall draw, capped at 300W" }
}
```

Then the benchmarked configuration, in `platforms`:

```json
{
  "id": "some_platform",
  "display": {
    "label": "Some Accelerator ×2 (96 GB)",
    "short": "SomeAcc×2",
    "color": "#7ec8ff",
    "group": "NVIDIA"
  },
  "composition": [{ "unit": "some_card", "count": 2 }],
  "perf": {
    "moe": {
      "note": "llama.cpp Vulkan Q4_K_XL, Qwen3.5-35B-A3B",
      "prefill": { "512": [3100, "m"], "4096": [2900, "m"], "32768": [2100, "e"] },
      "decode":  { "short": [142.0, "m"], "at32k": [96.4, "m"] }
    }
  }
}
```

`group` sections the tables (`NVIDIA`, `AMD`, `Unified`, `Value`, or a new one).
`color` must be unique across platforms and builds, and is what identifies the
device in every chart. The platform's price, power and 96 GB of capacity all
come from `2 × some_card` — writing any of them on the platform is rejected.

If it is also a box you would buy, add it to `builds`:

```json
{
  "id": "b_someacc",
  "display": { "label": "Some Accelerator ×2 workstation", "short": "SomeAcc×2", "color": "#7ec8ff" },
  "units": [{ "platform": "some_platform", "count": 1 }],
  "host": { "costUsd": 900, "loadW": 80, "idleW": 20, "note": "chassis + PSU" }
}
```

## Why compositions

Nothing that can be derived is stored. Cost, load draw, idle draw and capacity
are summed from the catalog every time the page renders, so there is no second
copy to fall out of date.

A build reaches its hardware one of two ways:

```json
"units": [{ "platform": "v100", "count": 1 }]     // through a benchmarked platform
"units": [{ "unit": "rtx_3090", "count": 4 }]     // straight from the catalog
```

Use `platform` when the box is a benchmarked configuration. Use `unit` when the
hardware appears only inside a rig and was never benchmarked on its own — the
RTX 3090 and A100 are in the catalog for exactly this reason, with no platform
record because there is no benchmark data for them.

`host` is for whatever the units do not account for — chassis, CPU, PSU,
cooling. It exists so the residual stays visible rather than getting smuggled
into a card price. The four-card PG199 entry is described in its source as
"~$6,000 + host", and that "+ host" belongs here once someone prices it.

A build with exactly one unit of one platform, and no `decode` of its own,
inherits that platform's decode rate — one of a thing performs like that thing.
Everything else states its own, because a four-card rig does not decode four
times as fast as one card.

### Unknown is not zero

If a unit has no street price, the totals that depend on it come out **unknown**
rather than zero. A silent zero would make a rig look free and infinitely
efficient, which is worse than a blank. The validator names the unit and the
missing field.

Only units that a *build* reaches need a price and power figure. A platform that
exists purely to be benchmarked — a 32GB card that never clears the 96GB bar and
so never appears in the value tables — is legitimately unpriced. `rtx_5090` and
`radeon_r9700` are both in that position today.

### `power` is not `tdpW`

`power.loadW` is the draw **observed under LLM inference**, per unit. It is
deliberately not the datasheet TDP: inference is bandwidth-bound and does not
reach the compute ceiling, and these cards are routinely power-capped. Summing
TDPs would overstate a 4× 3090 rig by about 40% and reshuffle the efficiency
rankings. Keep the datasheet figure in `tdpW` if you want it recorded; nothing
derives from it.

### Platforms are not all the same size

`v100` and `b70` are four-card platforms — their labels say "×4" and their
benchmarks were run on four cards — so their `composition` is `count: 4` of a
single card, and the builds that contain them are `count: 1` of the platform.
`pg199` is a single card, so its build is `count: 4` of the platform.

Both spellings give the same totals. What matters is that the card is the thing
with a price, and the multiplication happens in exactly one place.

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

**A precision** — add a key under a unit's `compute.values`. A column appears in
the hardware catalog table automatically. Suffix with `:sparse` for
structured-sparsity figures.

**A price kind** — add a key under a unit's `pricing`. `msrp` and `street` are
rendered today, and `street` is what build costs are summed from; anything else
is stored and ignored until something renders it.

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
