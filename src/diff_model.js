#!/usr/bin/env node
'use strict';

/**
 * Completeness diff: the generated extract vs the baseline Requirements Model.
 *
 * The extractor is "complete" for an entity when its generated file is byte-identical, up to the
 * trailing newline, to the hand-authored copy in releases/<BASELINE_DIR>/model_rules/. Anything
 * short of that is a gap in the derivation (a missing check-function mapping, a curated
 * Requirement that cannot be re-derived, a rule the markdown no longer expresses). This reports
 * those gaps per entity.
 *
 * Entities are compared by mirrored relative path, since the output tree mirrors the baseline
 * layout. Each shared entity lands in one of four buckets:
 *   identical        - byte-equal apart from the trailing newline; fully derived
 *   formatting only  - same rules and key order, different whitespace
 *   key order only   - same rules and values, different key order
 *   content differs  - rules added, removed, or changed
 *
 * Baseline entities with no generated counterpart are split by cause so that out-of-scope
 * entity kinds and dead tombstone files never read as extraction gaps.
 *
 * Run `npm run extract` first. Exits 0 unless --strict is passed.
 *
 * Flags: --summary (counts only)  --strict (exit non-zero on a content gap)
 */

const fs = require('fs');
const path = require('path');

const { UsageError, parseArgs, runMain } = require('./cli');

const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const BASELINE_DIR = process.env.BASELINE_DIR || 'latest';

// The subfolder both trees share. Entities are walked relative to it, but reported with it
// prefixed back on, so a printed path can be pasted onto either folder root as-is.
const MODEL_DIR = 'model_rules';
const entityPath = (rel) => path.join(MODEL_DIR, rel);

// The two trees compared, defaulted to match extract_rm.js and re-pointed in main().
let OUTPUT_ROOT = path.join(__dirname, 'output', MODEL_DIR);
let BASELINE_ROOT = path.join(RELEASES_DIR, BASELINE_DIR, MODEL_DIR);
let BASELINE_LABEL = `releases/${BASELINE_DIR}`;

// Entity kinds the extractor does not generate: the contract defines no Objects entity, and
// conditions markdown is read only for the anchor -> ConditionId map, never expanded into rules.
const OUT_OF_SCOPE = (rel) => {
  const parts = rel.split(path.sep);
  return parts[0] === 'conditions' || parts.includes('objects');
};

// Set in main() from the parsed options, so requiring this module never reads argv.
let SUMMARY_ONLY = false;
let STRICT = false;
const MAX_VALUE = 88;    // widest single-line value before it is clipped
const WRAP = 110;        // column the wrapped list detail folds at
const MAX_ITEMS = 12;    // list entries printed before the rest collapse into a count
const MIN_PREFIX = 6;    // shortest shared id prefix worth hoisting out of a list
const STR_CONTEXT = 30;  // characters of matching text kept either side of a sentence change
const MIN_COMMON = 16;   // matching run that makes two sentences worth aligning rather than clipping

/** Every .json file under `root`, as sorted root-relative paths. */
function walk(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith('.json')) out.push(path.relative(root, p));
    }
  })(root);
  return out.sort();
}

/** Recursively key-sorted copy, so two values compare equal regardless of key order. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

const sameContent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sameOrder = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Leaf-level differences between two rules as [{ path, baseline, generated }]. Objects recurse;
 * arrays compare whole, since a reordered Dependencies list is one meaningful difference rather
 * than several.
 */
function fieldDiffs(a, b, prefix = '') {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...fieldDiffs(a[k], b[k], prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (sameOrder(a, b)) return [];
  return [{ path: prefix, baseline: a, generated: b }];
}

const render = (v) => {
  if (v === undefined) return '(absent)';
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + '…' : s;
};

/**
 * One-line label for a list item, so list diffs read as rule ids rather than raw JSON.
 * `{CheckFunction: 'CheckModelRule', ModelRuleId: X}` is the overwhelmingly common shape and
 * collapses to `X`; everything else renders as `Fn(Key=value, …)`, recursing into nested Items.
 */
function itemLabel(v) {
  // A list entry that is just an id prints bare, so the shared prefix is not fenced off by a
  // quote; a string sitting in a Key=value slot keeps its quotes, where the bound matters.
  return typeof v === 'string' ? v || '""' : valueLabel(v);
}

function valueLabel(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(itemLabel).join(', ')}]`;
  const rest = Object.keys(v).filter((k) => k !== 'CheckFunction');
  const fn = v.CheckFunction;
  if (fn === 'CheckModelRule' && rest.length === 1 && rest[0] === 'ModelRuleId') return String(v.ModelRuleId);
  const body = rest.map((k) => (k === 'Items' ? valueLabel(v[k]) : `${k}=${valueLabel(v[k])}`)).join(', ');
  return fn ? `${fn}(${body})` : `{${body}}`;
}

/**
 * The leading text every label shares, cut back to a `-` or `.` boundary. Rule ids within one
 * entity share a long prefix (`CAU-SkuPriceDetails-C-`); printing it once per field and only the
 * distinguishing tail per item is what makes a 14-item list legible. Lists that mix entities
 * share no usable prefix and are left whole.
 */
function sharedPrefix(labels) {
  if (labels.length < 2) return '';
  let p = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < p.length && i < l.length && p[i] === l[i]) i += 1;
    p = p.slice(0, i);
    if (!p) return '';
  }
  const cut = Math.max(p.lastIndexOf('-'), p.lastIndexOf('.'));
  p = cut >= 0 ? p.slice(0, cut + 1) : '';
  // Worth eliding only when it is a strict prefix of every label and buys back real width.
  return p.length >= MIN_PREFIX && labels.every((l) => l.length > p.length) ? p : '';
}

/** Indices into `a` of the items `b` does not also carry, counting duplicates. */
function surplusIndices(a, b) {
  const have = b.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const seen = new Map();
  return a.reduce((out, k, i) => {
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > (have.get(k) || 0)) out.push(i);
    return out;
  }, []);
}

/** Long lists print as a head plus a count, so one entity's detail stays scannable. */
const capped = (labels) =>
  labels.length > MAX_ITEMS
    ? [...labels.slice(0, MAX_ITEMS), `… and ${labels.length - MAX_ITEMS} more`]
    : labels;

/** `tag` then `labels` comma-joined, wrapped to WRAP columns with the tail hanging under them. */
function wrapList(tag, labels, pad) {
  const hang = pad + ' '.repeat(tag.length + 1);
  const out = [];
  let line = '';
  labels.forEach((l, i) => {
    const piece = i === labels.length - 1 ? l : `${l},`;
    const indent = out.length ? hang.length : pad.length + tag.length + 1;
    if (line && indent + line.length + 1 + piece.length > WRAP) {
      out.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  });
  if (line) out.push(line);
  return out.map((l, i) => (i ? hang + l : `${pad}${tag} ${l}`));
}

/**
 * An array-valued difference as ordering / additions / deletions rather than two truncated JSON
 * blobs. A reordered Dependencies list and one that gained a rule are different kinds of gap, and
 * the old single-line render — both sides clipped at the same shared prefix — showed neither.
 */
function arrayDiffLines(label, a, b, pad) {
  const keyOf = (v) => JSON.stringify(canonical(v));
  const aKeys = a.map(keyOf);
  const bKeys = b.map(keyOf);
  const removed = new Set(surplusIndices(aKeys, bKeys));
  const added = new Set(surplusIndices(bKeys, aKeys));
  const keptA = aKeys.filter((_, i) => !removed.has(i));
  const keptB = bKeys.filter((_, i) => !added.has(i));
  const reordered = JSON.stringify(keptA) !== JSON.stringify(keptB);

  const strip = sharedPrefix([...a, ...b].map(itemLabel));
  const show = (v) => itemLabel(v).slice(strip.length);
  const note = strip ? `  [ids under ${strip}…]` : '';
  const sub = pad + '    ';

  if (!added.size && !removed.size) {
    // Same items in different positions: the two orders are the whole of the difference.
    return [
      `${pad}${label}: ordering only, ${a.length} item${a.length === 1 ? '' : 's'}${note}`,
      ...wrapList('baseline: ', capped(a.map(show)), sub),
      ...wrapList('generated:', capped(b.map(show)), sub),
    ];
  }

  const counts = [];
  if (added.size) counts.push(`+${added.size} added`);
  if (removed.size) counts.push(`-${removed.size} removed`);
  counts.push(`${keptA.length} kept${keptA.length && reordered ? ', reordered' : ''}`);
  // The overflow line carries no +/- marker: it is a count, not an item.
  const bullet = (mark, labels) =>
    capped(labels).map((l, i) => `${sub}${i < MAX_ITEMS ? mark : ' '} ${l}`);
  return [
    `${pad}${label}: ${counts.join(', ')} (${a.length} -> ${b.length} items)${note}`,
    ...bullet('+', [...added].map((i) => show(b[i]))),
    ...bullet('-', [...removed].map((i) => show(a[i]))),
  ];
}

/**
 * Two long sentences aligned on the part that actually changed, or null when they are not two
 * variants of one sentence. Clipping both at a fixed width hid every MustSatisfy difference
 * behind an identical opening clause; instead the matching head and tail are elided and the
 * change shown with STR_CONTEXT characters either side.
 */
function stringDiffLines(label, a, b, pad) {
  if (Math.max(a.length, b.length) <= MAX_VALUE) return null;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  if (head < MIN_COMMON && tail < MIN_COMMON) return null;

  const window = (v) => {
    const start = Math.max(0, head - STR_CONTEXT);
    const end = Math.min(v.length, v.length - tail + STR_CONTEXT);
    const limit = MAX_VALUE + 2 * STR_CONTEXT;
    let mid = v.slice(start, end);
    if (mid.length > limit) mid = mid.slice(0, limit - 1) + '…';
    return (start > 0 ? '…' : '') + mid + (end < v.length ? '…' : '');
  };
  return [
    `${pad}${label}: text differs at char ${head + 1}`,
    `${pad}    baseline:  ${JSON.stringify(window(a))}`,
    `${pad}    generated: ${JSON.stringify(window(b))}`,
  ];
}

/** One field difference as printable lines: arrays and long sentences structured, the rest inline. */
function diffLines(d, pad) {
  const { path: label, baseline: a, generated: b } = d;
  if (Array.isArray(a) && Array.isArray(b)) return arrayDiffLines(label, a, b, pad);
  if (typeof a === 'string' && typeof b === 'string') {
    const aligned = stringDiffLines(label, a, b, pad);
    if (aligned) return aligned;
  }
  return [`${pad}${label}: ${render(a)} -> ${render(b)}`];
}

/**
 * Whether two file texts are equal ignoring the final newline. Editors add or strip the trailing
 * newline on save, and the baseline carries both styles, so that one byte is not a derivation
 * gap. Every other whitespace difference still falls through to the formatting bucket.
 */
const sameText = (a, b) => a.replace(/\r?\n$/, '') === b.replace(/\r?\n$/, '');

/** Compare one shared entity. Returns its bucket plus rule-level detail when content differs. */
function compareEntity(rel) {
  const baseText = fs.readFileSync(path.join(BASELINE_ROOT, rel), 'utf8');
  const outText = fs.readFileSync(path.join(OUTPUT_ROOT, rel), 'utf8');
  if (sameText(baseText, outText)) return { rel, bucket: 'identical' };

  const base = JSON.parse(baseText);
  const out = JSON.parse(outText);
  if (sameOrder(base, out)) return { rel, bucket: 'formatting' };
  if (sameContent(base, out)) return { rel, bucket: 'keyOrder' };

  const baseOnly = Object.keys(base).filter((id) => !(id in out));
  const outOnly = Object.keys(out).filter((id) => !(id in base));
  const changed = Object.keys(base)
    .filter((id) => id in out && !sameOrder(base[id], out[id]))
    .map((id) => ({ id, diffs: fieldDiffs(base[id], out[id]) }));
  return { rel, bucket: 'content', baseOnly, outOnly, changed };
}

/** Split baseline-only entities by cause: out of scope, dead tombstone file, or a real gap. */
function classifyBaselineOnly(rel) {
  if (OUT_OF_SCOPE(rel)) return 'outOfScope';
  const rules = JSON.parse(fs.readFileSync(path.join(BASELINE_ROOT, rel), 'utf8'));
  const ids = Object.keys(rules);
  // Every rule already Removed means the markdown is gone and there is nothing left to derive.
  return ids.length && ids.every((id) => rules[id].Status === 'Removed') ? 'tombstoneOnly' : 'missing';
}

const USAGE = `Usage: node diff_model.js [options]

Options:
  --baseline <folder>  Release folder to compare against. Default: releases/${BASELINE_DIR}.
  --output <folder>    Generated model to compare. Default: the extractor's own output/ folder.
  --summary            Print only the completeness summary, not the per-entity detail.
  --strict             Exit non-zero unless every shared entity is byte-identical.
  -h, --help           Show this message.

Both folders must name what the extract run used. Folders may be relative to the working
directory. Environment: BASELINE_DIR (a folder name under releases/, overridden by --baseline).`;

function main() {
  const opts = parseArgs(process.argv.slice(2), ['baseline', 'output'], ['summary', 'strict']);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  SUMMARY_ONLY = Boolean(opts.summary);
  STRICT = Boolean(opts.strict);
  if (opts.baseline) {
    BASELINE_ROOT = path.join(path.resolve(opts.baseline), MODEL_DIR);
    BASELINE_LABEL = opts.baseline;
  }
  if (opts.output) OUTPUT_ROOT = path.join(path.resolve(opts.output), MODEL_DIR);

  if (!fs.existsSync(BASELINE_ROOT)) {
    throw new UsageError(`Baseline not found: ${BASELINE_ROOT}\nPass --baseline <folder>, or set BASELINE_DIR to a folder name under releases/.`);
  }
  if (!fs.existsSync(OUTPUT_ROOT)) {
    throw new UsageError(`No generated model at ${OUTPUT_ROOT}\nRun the extractor first, or pass --output <folder>.`);
  }

  const baseFiles = walk(BASELINE_ROOT);
  const outFiles = walk(OUTPUT_ROOT);
  const outSet = new Set(outFiles);
  const baseSet = new Set(baseFiles);

  const shared = baseFiles.filter((f) => outSet.has(f)).map(compareEntity);
  const buckets = { identical: [], formatting: [], keyOrder: [], content: [] };
  for (const e of shared) buckets[e.bucket].push(e);

  const baselineOnly = { outOfScope: [], tombstoneOnly: [], missing: [] };
  for (const rel of baseFiles.filter((f) => !outSet.has(f))) baselineOnly[classifyBaselineOnly(rel)].push(rel);
  const generatedOnly = outFiles.filter((f) => !baseSet.has(f));

  const pct = shared.length ? Math.round((buckets.identical.length / shared.length) * 100) : 0;
  const row = (label, n, note) => console.log(`  ${label.padEnd(28)}${String(n).padStart(4)}${note ? '   ' + note : ''}`);

  console.log(`Model completeness: generated extract vs ${BASELINE_LABEL}\n`);
  console.log(`Shared entities              ${String(shared.length).padStart(4)}`);
  row('identical (byte-equal)', buckets.identical.length, `${pct}% of shared`);
  row('formatting only', buckets.formatting.length);
  row('key order only', buckets.keyOrder.length);
  row('content differs', buckets.content.length);
  console.log(`\nBaseline entities not generated ${String(baseFiles.length - shared.length).padStart(1)}`);
  row('out of extractor scope', baselineOnly.outOfScope.length, 'conditions/, objects/');
  row('tombstone-only', baselineOnly.tombstoneOnly.length, 'no markdown; nothing to derive');
  row('missing (has active rules)', baselineOnly.missing.length, baselineOnly.missing.length ? '<- gap' : '');
  if (generatedOnly.length) {
    console.log(`\nGenerated entities not in baseline ${String(generatedOnly.length).padStart(1)}`);
    for (const rel of generatedOnly) console.log(`    ${entityPath(rel)}`);
  }

  // A content gap is a derivation failure: rules the extractor cannot reproduce, or entities
  // one side lacks. Key order and whitespace are serialization drift in the hand-authored
  // baseline (which carries 25 distinct key orders), not something the extractor got wrong, so
  // they are reported separately and do not fail --strict.
  const gaps = buckets.content.length + baselineOnly.missing.length + generatedOnly.length;
  const drift = buckets.formatting.length + buckets.keyOrder.length;
  const entities = (n) => (n === 1 ? '1 entity differs' : `${n} entities differ`);
  if (gaps) console.log(`\n❌ Model has gaps: ${entities(gaps)} from the baseline in content.`);
  else if (drift) console.log(`\n✅ Content COMPLETE: every in-scope entity matches the baseline. ${entities(drift)} only in key order or whitespace, which is baseline drift to normalize.`);
  else console.log('\n✅ Model COMPLETE: every in-scope entity is byte-identical to the baseline.');

  if (SUMMARY_ONLY || !(gaps + drift)) return gaps;

  if (baselineOnly.missing.length) {
    console.log('\n── Baseline entities with active rules and no generated file ──');
    for (const rel of baselineOnly.missing) console.log(`  ${entityPath(rel)}`);
  }

  const detailed = [...buckets.content, ...buckets.keyOrder, ...buckets.formatting];
  if (detailed.length) console.log('\n── Entities that differ ──');
  for (const e of detailed) {
    if (e.bucket !== 'content') {
      console.log(`\n${entityPath(e.rel)}\n  (${e.bucket === 'formatting' ? 'whitespace only' : 'key order only'}; rules and values match)`);
      continue;
    }
    const n = e.baseOnly.length + e.outOnly.length + e.changed.length;
    console.log(`\n${entityPath(e.rel)}  (${n} rule${n === 1 ? '' : 's'})`);
    for (const id of e.baseOnly) console.log(`  - ${id}  in baseline only`);
    for (const id of e.outOnly) console.log(`  + ${id}  generated only`);
    for (const { id, diffs } of e.changed) {
      console.log(`  ~ ${id}`);
      for (const d of diffs) for (const line of diffLines(d, '      ')) console.log(line);
    }
  }
  return gaps;
}

// Guarded so the module can be required without running a comparison, matching the other
// entry points; previously any require() of this file executed main() and exited the process.
if (require.main === module) {
  runMain(() => {
    const gaps = main();
    process.exit(STRICT && gaps ? 1 : 0);
  }, USAGE);
}

module.exports = { fieldDiffs, itemLabel, sharedPrefix, arrayDiffLines, diffLines };
