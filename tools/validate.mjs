#!/usr/bin/env node
// Validates data/compendium.json against data/schema.json, then runs the
// semantic checks a schema cannot express.
//
// Implements the JSON Schema subset the schema actually uses rather than
// pulling in a validator, so the repo stays a static site with no package.json
// and CI needs no install step.
//
//   node tools/validate.mjs [path/to/compendium.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../assets/models.js';
import { WEIGHT_FORMATS } from '../assets/ceiling.js';
import { FORMATS } from '../assets/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docPath = process.argv[2] ?? path.join(root, 'data/compendium.json');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'data/schema.json'), 'utf8'));
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const rel = path.relative(root, docPath) || docPath;

const errors = [];
const warnings = [];
const fail = (at, msg) => errors.push(`${at || '(root)'}: ${msg}`);
const warn = (at, msg) => warnings.push(`${at || '(root)'}: ${msg}`);

function deref(node) {
  if (!node || !node.$ref) return node;
  const parts = node.$ref.replace(/^#\//, '').split('/');
  return parts.reduce((acc, k) => acc[k], schema);
}

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function check(value, rawNode, at) {
  const node = deref(rawNode);
  if (!node) return;

  if (node.oneOf) {
    const matches = node.oneOf.filter(sub => {
      const before = errors.length;
      check(value, sub, at);
      const ok = errors.length === before;
      errors.length = before;
      return ok;
    });
    if (matches.length !== 1) {
      fail(at, `does not match exactly one allowed form (matched ${matches.length}); got ${JSON.stringify(value)}`);
    }
    return;
  }

  if (node.enum && !node.enum.includes(value)) {
    fail(at, `must be one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (node.type) {
    const t = typeOf(value);
    const want = node.type === 'integer' ? 'number' : node.type;
    if (t !== want || (node.type === 'integer' && !Number.isInteger(value))) {
      fail(at, `expected ${node.type}, got ${t}`);
      return;
    }
  }

  if (typeof value === 'number') {
    if (node.minimum != null && value < node.minimum) fail(at, `must be >= ${node.minimum}`);
    if (node.exclusiveMinimum != null && value <= node.exclusiveMinimum) {
      fail(at, `must be > ${node.exclusiveMinimum}, got ${value}`);
    }
    if (node.maximum != null && value > node.maximum) fail(at, `must be <= ${node.maximum}, got ${value}`);
  }

  if (typeof value === 'string' && node.pattern && !new RegExp(node.pattern).test(value)) {
    fail(at, `"${value}" does not match ${node.pattern}`);
  }

  if (Array.isArray(value)) {
    if (node.minItems != null && value.length < node.minItems) fail(at, `needs at least ${node.minItems} items`);
    if (node.maxItems != null && value.length > node.maxItems) fail(at, `allows at most ${node.maxItems} items`);
    if (Array.isArray(node.items)) {
      node.items.forEach((sub, i) => i < value.length && check(value[i], sub, `${at}[${i}]`));
    } else if (node.items) {
      value.forEach((v, i) => check(v, node.items, `${at}[${i}]`));
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const req of node.required ?? []) {
      if (!(req in value)) fail(at, `missing required property "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = node.properties?.[k];
      if (sub) {
        check(v, sub, at ? `${at}.${k}` : k);
        continue;
      }
      if (node.additionalProperties === false) {
        fail(at, `unknown property "${k}"`);
        continue;
      }
      if (node.propertyNames?.pattern && !new RegExp(node.propertyNames.pattern).test(k)) {
        fail(at, `key "${k}" does not match ${node.propertyNames.pattern}`);
      }
      if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        check(v, node.additionalProperties, at ? `${at}.${k}` : k);
      }
    }
  }
}

check(doc, schema, '');

// --- Semantic checks -------------------------------------------------------
// Shapes can be right while meanings are wrong. These catch the cross-record
// mistakes that are easy to make by copy-paste, and the omissions that quietly
// turn a number into folklore.

const seenIds = new Map();
for (const rec of [...(doc.architectures ?? []), ...(doc.units ?? []), ...(doc.lines ?? []), ...(doc.candidates ?? [])]) {
  if (seenIds.has(rec.id)) fail(`id "${rec.id}"`, 'duplicate id');
  seenIds.set(rec.id, rec);
}

const archById = Object.fromEntries((doc.architectures ?? []).map(a => [a.id, a]));
const unitById = Object.fromEntries((doc.units ?? []).map(u => [u.id, u]));

// --- Units and their generations
for (const u of doc.units ?? []) {
  const at = `unit "${u.id}"`;
  if (!u.arch) warn(at, 'names no chip generation (arch), so every format reads as unknown');
  else if (!archById[u.arch]) fail(at, `names unknown architecture "${u.arch}"`);
  if (u.formatOverrides && !u.note) fail(at, 'overrides its generation\'s formats without a note saying why');

  // A rated figure proves the matrix path exists; a generation that says it
  // does not is contradicting a datasheet, and one of the two is wrong.
  const arch = archById[u.arch];
  for (const key of Object.keys(u.compute?.values ?? {})) {
    // A vector rate is a shader-ALU figure, which a matrix-less card can have.
    if (key.endsWith(':vector')) continue;
    const f = key.replace(':sparse', '');
    if (!FORMATS.includes(f)) continue;
    const state = u.formatOverrides?.[f] ?? arch?.formats?.[f];
    if (state === 'absent') fail(at, `has a rated ${key} figure, but ${u.formatOverrides?.[f] ? 'its own override' : `its generation (${u.arch})`} says ${f} is absent`);
  }
  for (const key of u.compute?.unofficial ?? []) {
    if (!(key in (u.compute.values ?? {}))) fail(at, `marks ${key} unofficial, but has no ${key} figure`);
  }
  if (u.compute?.unofficial?.length && !u.compute.note) fail(at, 'marks figures unofficial without a compute note saying where they come from');
  if (u.formFactor?.name === 'integrated' && u.hostLink) fail(at, 'is an integrated GPU but records a PCIe host link');
  if (u.hostLink && !u.formFactor) warn(at, 'records a host link but no form factor');
  const link = u.peerLink;
  if (link) {
    if (link.maxCards > 0 && !link.fabric) fail(at, `links ${link.maxCards} cards without naming the fabric`);
    if (link.maxCards < 2 && link.options?.length) fail(at, 'lists link group sizes but says it has no link');
    for (const n of link.options ?? []) if (n >= link.maxCards) fail(at, `lists a ${n}-card link group, which is not smaller than its maxCards of ${link.maxCards}`);
    if (link.maxCards === 1) fail(at, 'says one card is linked to itself; use 0 for no link');
  }
  for (const [f, state] of Object.entries(u.formatOverrides ?? {})) {
    if (arch?.formats?.[f] === state) warn(at, `overrides ${f} to "${state}", which is what its generation already says`);
  }

  const street = u.pricing?.street;
  const msrp = u.pricing?.msrp;
  if (msrp && street && msrp.usd === street.usd && msrp.asOf === street.asOf) {
    fail(at, 'msrp and street are identical including date -- one of them is probably a copy-paste');
  }
}

// A specification without a source is exactly the kind of confidently-wrong
// number this page exists to warn about. One citation per record is the floor.
const SPEC_FIELDS = ['released', 'memoryBandwidthGBs', 'tdpW', 'process'];
for (const u of doc.units ?? []) {
  const hasSpecs = SPEC_FIELDS.some(f => u[f] != null) || Object.keys(u.compute?.values ?? {}).length > 0;
  if (hasSpecs && !(u.sources?.length || u.compute?.source)) {
    fail(`unit "${u.id}"`, 'has specification values but no sources[] -- say where they came from');
  }
}

for (const a of doc.architectures ?? []) {
  if (!Object.values(a.formats).some(v => v !== 'unknown')) warn(`architecture "${a.id}"`, 'classifies nothing yet');
  // A classification is a claim like any other: some source has to make it.
  const said = new Set((a.sources ?? []).flatMap(s => s.supports ?? []));
  for (const [f, state] of Object.entries(a.formats)) {
    const token = state === 'native' ? f : state === 'absent' ? `${f}:absent` : null;
    if (token && !said.has(token)) {
      fail(`architecture "${a.id}"`, `says ${f} is ${state}, but no source supports it (add "${token}" to a source's supports, or mark it unknown)`);
    }
  }
}

// --- Rigs
const exists = (id, at) => {
  if (!unitById[id]) fail(at, `references unknown unit "${id}" -- add it to the units catalog`);
  return !!unitById[id];
};
const checkRig = (rig, at) => {
  (rig.units ?? []).forEach((c, i) => exists(c.unit, `${at} rig.units[${i}]`));
  // An interconnect rating is a vendor claim like any other spec: say whose.
  const ic = rig.interconnect;
  if (ic && (ic.peakP2pGBsPerGpu != null || ic.hostLinkGBs != null || ic.linksPerGpu != null) && !ic.source) {
    fail(at, 'interconnect carries link figures but no source -- say where they came from');
  }
  if (ic?.costHighUsd != null && ic.costUsd == null) fail(at, 'interconnect gives a high price but no low one (costUsd)');
  if (ic?.costHighUsd != null && ic.costUsd != null && ic.costHighUsd < ic.costUsd) {
    fail(at, `interconnect price range is reversed: ${ic.costUsd} to ${ic.costHighUsd}`);
  }
};

const modelKnown = (id, at) => {
  if (!MODELS[id]) fail(at, `model "${id}" is not in MODELS (assets/models.js) -- add its shape, sourced, first`);
};

// --- The ledger
for (const l of doc.lines ?? []) {
  const at = `line "${l.id}"`;
  if (l.model == null) {
    if (!l.modelNote) fail(at, 'has no model and no modelNote saying what the source did call it');
  } else {
    modelKnown(l.model, at);
    if (l.modelParams) fail(at, 'gives modelParams for a named model -- its shape in MODELS already says this');
  }
  checkRig(l.rig, at);
  if (l.quant.key && !WEIGHT_FORMATS[l.quant.key]) fail(at, `quant.key "${l.quant.key}" is not in WEIGHT_FORMATS (assets/ceiling.js)`);
  const cards = (l.rig.units ?? []).reduce((n, u) => n + u.count, 0);
  if (cards > 1 && !l.parallel) warn(at, `runs on ${cards} cards without saying how the model was split (parallel), so it has no ceiling`);
  if (l.parallel && cards === 1) fail(at, 'states a parallel split on a single card');
  if (l.observed && l.recorded && l.observed.slice(0, l.recorded.length) > l.recorded) {
    fail(at, `was observed (${l.observed}) after it was recorded (${l.recorded})`);
  }

  if (l.status === 'measured' && !l.results?.length) fail(at, 'is measured but has no results');
  if (l.status === 'withdrawn' && !l.hazards?.length) fail(at, 'is withdrawn but hazards[] never says why');
  if (['issue-report', 'forum'].includes(l.provenance.kind) && l.provenance.reproduced == null) {
    fail(at, `a ${l.provenance.kind} must say whether anyone has reproduced it (provenance.reproduced)`);
  }
  if (l.provenance.attestation === 'witnessed' && l.provenance.kind !== 'first-party') {
    fail(at, `a ${l.provenance.kind} cannot be witnessed -- only first-party measurements can be; use "reported"`);
  }
  if (l.provenance.kind === 'first-party' && !l.provenance.digest) {
    warn(at, 'is first-party but pins no digest -- a reader cannot tell the receipts have not moved');
  }

  const seenPoints = new Set();
  (l.results ?? []).forEach((r, i) => {
    const pt = `${at} results[${i}]`;
    if ((r.value == null) === (r.range == null)) fail(pt, 'needs exactly one of value or range');
    if (r.range && r.range[0] > r.range[1]) fail(pt, `range ${JSON.stringify(r.range)} is reversed`);
    if (r.depth == null && !r.depthNote) fail(pt, 'has no depth and no depthNote saying what the source did say about it');
    if (r.streams === 1 && r.basis !== 'per-stream') {
      fail(pt, 'one stream is per-stream by definition -- aggregate needs streams > 1');
    }
    if (r.metric === 'prefill' && !r.prefillBasis) {
      fail(pt, 'a prefill rate must say whether it is cold or over new tokens only (prefillBasis)');
    }
    if (r.metric !== 'prefill' && r.prefillBasis) fail(pt, 'prefillBasis only applies to prefill points');
    if (r.metric === 'prefill' && r.spec) fail(pt, 'spec only applies to decode points');
    if (l.pool?.tokens && r.depth != null && r.depth * r.streams > l.pool.tokens) {
      warn(pt, `${r.streams} stream(s) at depth ${r.depth} is more than the ${l.pool.tokens}-token pool`);
    }
    const key = [r.metric, r.depth ?? '?', r.streams, r.basis, r.spec ?? '-', r.prefillBasis ?? '-'].join('|');
    if (seenPoints.has(key) && r.depth != null) fail(pt, 'repeats an earlier point at the same metric, depth, streams, basis and spec');
    seenPoints.add(key);
  });
}

for (const c of doc.candidates ?? []) {
  const at = `candidate "${c.id}"`;
  checkRig(c.rig, at);
  c.models.forEach(m => modelKnown(m, at));
}

// --- Report ----------------------------------------------------------------
process.on('uncaughtException', err => {
  console.error(`✗ ${rel} — the validator itself crashed, which is a bug in tools/validate.mjs:`);
  console.error(err.stack);
  process.exit(2);
});

if (errors.length) {
  console.error(`✗ ${rel} — ${errors.length} problem${errors.length > 1 ? 's' : ''}:\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const points = (doc.lines ?? []).reduce((n, l) => n + (l.results?.length ?? 0), 0);
for (const w of warnings) console.warn(`  ! ${w}`);
console.log(
  `✓ ${rel} — ${(doc.architectures ?? []).length} chip generations, ${(doc.units ?? []).length} catalog units, ` +
    `${(doc.lines ?? []).length} serving lines with ${points} readings, ${(doc.candidates ?? []).length} candidates`
);
