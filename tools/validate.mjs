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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docPath = process.argv[2] ?? path.join(root, 'data/compendium.json');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'data/schema.json'), 'utf8'));
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const rel = path.relative(root, docPath) || docPath;

const errors = [];
const fail = (at, msg) => errors.push(`${at || '(root)'}: ${msg}`);

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
// mistakes that are easy to make when adding a device by copy-paste.

const archIds = new Set(doc.meta.archetypes.map(a => a.id));
const ctxTokens = new Set(doc.meta.contexts.map(c => c.tokens));
const seenIds = new Map();
const seenColors = new Map();

for (const rec of [...doc.platforms, ...(doc.builds ?? [])]) {
  const at = `id "${rec.id}"`;
  if (seenIds.has(rec.id)) fail(at, 'duplicate id');
  seenIds.set(rec.id, rec);

  // A build reuses the colour of the platform it contains -- b_pg199 and pg199
  // are the same silicon. Any other collision is a copy-paste slip that makes
  // two unrelated series indistinguishable in the charts.
  const silicon = new Set([rec.id, ...(rec.units ?? []).map(u => u.platform).filter(Boolean)]);
  const prev = seenColors.get(rec.display.color);
  const shares = prev && [...silicon].some(s => prev.silicon.has(s));
  if (prev && !shares) {
    fail(at, `colour ${rec.display.color} already used by "${prev.id}" (${prev.display.short})`);
  }
  seenColors.set(rec.display.color, { ...rec, silicon });

  for (const arch of Object.keys(rec.perf ?? {})) {
    if (!archIds.has(arch)) fail(at, `perf archetype "${arch}" is not in meta.archetypes`);
  }
  for (const arch of Object.keys(rec.decode ?? {})) {
    if (!archIds.has(arch)) fail(at, `decode archetype "${arch}" is not in meta.archetypes`);
  }

  for (const [arch, perf] of Object.entries(rec.perf ?? {})) {
    for (const key of Object.keys(perf.prefill ?? {})) {
      if (!ctxTokens.has(Number(key))) {
        fail(`${at} ${arch}`, `prefill key ${key} is not a context in meta.contexts`);
      }
    }
    if (perf.unsupported && (perf.prefill || perf.decode)) {
      fail(`${at} ${arch}`, 'marked unsupported but still carries prefill/decode data');
    }
    if (!perf.unsupported && !perf.prefill && !perf.decode) {
      fail(`${at} ${arch}`, 'has neither data nor unsupported:true — delete it or say why it is empty');
    }
  }
}

for (const p of doc.platforms) {
  if (!p.display.group) fail(`id "${p.id}"`, 'platforms need display.group for table sectioning');
  const street = p.pricing?.street?.usd;
  const msrp = p.pricing?.msrp?.usd;
  if (msrp != null && street != null && msrp === street && p.pricing.msrp.asOf === p.pricing.street?.asOf) {
    fail(`id "${p.id}"`, 'msrp and street are identical including date — one of them is probably a copy-paste');
  }
}

// Build cost and power are summed from units. A unit that cannot supply them
// does not error -- it contributes zero, which silently makes a rig look free
// and infinitely efficient. Catch it here instead.
const platformById = Object.fromEntries(doc.platforms.map(p => [p.id, p]));
for (const b of doc.builds ?? []) {
  (b.units ?? []).forEach((u, i) => {
    const at = `build "${b.id}" units[${i}]`;
    if (u.platform && u.label) {
      fail(at, 'has both platform and label — reference a platform or describe a unit, not both');
    }
    if (!u.platform && !u.label) fail(at, 'needs either a platform reference or a label');

    const src = u.platform ? platformById[u.platform] : u;
    if (u.platform && !src) {
      fail(at, `references unknown platform "${u.platform}"`);
      return;
    }
    const who = u.platform ?? `"${u.label}"`;
    if (src.pricing?.street?.usd == null) {
      fail(at, `${who} has no pricing.street.usd, so this build's cost cannot be derived`);
    }
    if (src.power?.loadW == null) {
      fail(at, `${who} has no power.loadW, so this build's efficiency cannot be derived`);
    }
    if (src.power?.idleW == null) {
      fail(at, `${who} has no power.idleW, so this build's standing cost cannot be derived`);
    }
  });
}

// --- Report ----------------------------------------------------------------
if (errors.length) {
  console.error(`✗ ${rel} — ${errors.length} problem${errors.length > 1 ? 's' : ''}:\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const points = doc.platforms.reduce(
  (n, p) =>
    n +
    Object.values(p.perf ?? {}).reduce(
      (m, a) => m + Object.keys(a.prefill ?? {}).length + Object.keys(a.decode ?? {}).length,
      0
    ),
  0
);
console.log(
  `✓ ${rel} — ${doc.platforms.length} platforms, ${(doc.builds ?? []).length} standalone builds, ` +
    `${doc.meta.archetypes.length} archetypes, ${points} datapoints`
);
