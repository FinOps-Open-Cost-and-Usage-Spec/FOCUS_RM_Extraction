#!/usr/bin/env node
'use strict';

/**
 * Correctness audit for the extractor output.
 *
 * Three layers:
 *  1. Structural integrity over EVERY generated file (no duplicate IDs, sorted,
 *     active-rule dependencies resolve within the file or to external ATT-* rules,
 *     composite Items == Dependencies, Keyword matches MustSatisfy).
 *  2. Every rule Active in the baseline but not Active in the output, across all
 *     entities: deleted ids fail, tombstoned ones are listed for editorial review.
 *  3. A deep transformation audit of the billing_period DATASET file, independently
 *     re-deriving expectations from its two inputs — the baseline JSON in
 *     releases/latest and the current dataset markdown.
 *
 * Verifies the transformation, not parity with the hand-authored target release.
 * Exits non-zero on any failure. Honors BASELINE_DIR / NEW_VERSION / DATASET_FOLDER, and the
 * --specification / --baseline / --output flags, which must name the same three folders the
 * extract run used or the audit re-derives its expectations from the wrong inputs.
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { renderInline, datasetJsonName, renameConditions } = require('./markdown_util');
const { DEFAULT_SPEC_ROOT, UsageError, parseArgs, specPath, runMain } = require('./cli');

const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const CONTRACT_PATH = path.join(__dirname, 'requirements_model_contract.json');

// Must resolve the same baseline as extract_rm.js, or the audit re-derives its
// expectations from a different release than the output was generated against.
const BASELINE_DIR = process.env.BASELINE_DIR || 'latest';
const DATASET_FOLDER = process.env.DATASET_FOLDER || 'billing_period';

// The three inputs, defaulted to match extract_rm.js and re-pointed by runVerify().
let SPEC_ROOT = DEFAULT_SPEC_ROOT;
let BASELINE_ROOT = path.join(RELEASES_DIR, BASELINE_DIR);
let OUTPUT_ROOT = path.join(__dirname, 'output', 'model_rules');
// Resolved in runVerify(), once BASELINE_ROOT is known.
let NEW_VERSION = BASELINE_DIR;

/** ModelVersion recorded in the baseline's model_details.json; falls back to the folder name. */
function baselineModelVersion() {
  const file = path.join(BASELINE_ROOT, 'model_details.json');
  if (!fs.existsSync(file)) return path.basename(BASELINE_ROOT);
  const details = JSON.parse(fs.readFileSync(file, 'utf8')).Details || {};
  return details.ModelVersion || path.basename(BASELINE_ROOT);
}

const normalize = (t) => t.trim().replace(/\s+/g, ' ');
const numericIdOf = (id) => { const m = id.match(/-(\d+)-[A-Z]$/); return m ? parseInt(m[1], 10) : -1; };

/** Every ModelRuleId named inside a Requirement or Condition, in traversal order. */
function modelRuleRefs(value) {
  const out = [];
  (function rec(v) {
    if (Array.isArray(v)) return v.forEach(rec);
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (k === 'ModelRuleId' && typeof v[k] === 'string') out.push(v[k]);
      else rec(v[k]);
    }
  })(value);
  return out;
}

// Independent of renderInline: raw HTML entities must never reach MustSatisfy. This
// guards against an encoding regression in markdown_util that the markdown-derived
// oracle (which shares renderInline) could not otherwise detect.
const HTML_ENTITY = /&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i;

/**
 * The dataset's columns composite: the Composite whose dependencies are all column roots.
 *
 * It gathers every column of a dataset under the dataset's root and is synthesized by the
 * extractor rather than derived from a sentence, so the markdown-derived expectations below do not
 * apply to it. Detected structurally, matching how extract_rm.js finds it in the baseline.
 */
function columnsCompositeId(rules) {
  const ids = Object.keys(rules).filter((id) => {
    const rule = rules[id];
    if (rule.Function !== 'Composite' || rule.Status === 'Removed') return false;
    const deps = (rule.ValidationCriteria || {}).Dependencies || [];
    return deps.length > 0 && deps.every((d) => /-C-000-/.test(d));
  });
  return ids.length === 1 ? ids[0] : null;
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// --- Layer 1: structural integrity for every generated file -----------------
function structuralChecks(check, warn) {
  const files = walkFiles(OUTPUT_ROOT);
  // Global ID sets so cross-file dependencies can be resolved and removed rules detected.
  const allIds = new Set();
  const removedIds = new Set();
  for (const file of files) {
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const id of Object.keys(rules)) { allIds.add(id); if (rules[id].Status === 'Removed') removedIds.add(id); }
  }
  let dupIds = 0, dupNums = 0, unsorted = 0, dangling = 0, inconsistent = 0, entities = 0, prefixMismatch = 0, undeclared = 0, dupOrders = 0;
  for (const file of files) {
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = Object.keys(rules);
    // Dataset/column rules must carry their DatasetType and an ID prefixed with it.
    const isDatasetScoped = path.sep + 'datasets' + path.sep;
    for (const id of ids) {
      const r = rules[id];
      if (r.Status === 'Removed') continue;
      if (file.includes(isDatasetScoped)) {
        if (!r.DatasetType) { prefixMismatch++; console.log('     missing DatasetType', id, 'in', path.basename(file)); }
        else if (!id.startsWith(r.DatasetType + '-')) { prefixMismatch++; console.log('     ID prefix != DatasetType', id, 'in', path.basename(file)); }
      }
    }
    const keys = new Set(ids);
    if (keys.size !== ids.length) { dupIds++; console.log('     dup IDs in', file); }
    const nums = ids.map(numericIdOf);
    if (new Set(nums).size !== nums.length) { dupNums++; console.log('     dup NumericIds in', file); }
    if (!ids.every((id, i) => i === 0 || numericIdOf(ids[i - 1]) <= numericIdOf(id))) { unsorted++; console.log('     unsorted', file); }
    // Order places a rule in the markdown, so two active rules in one entity must never share
    // one (the guard against an Order insertion having no integer room between its neighbours).
    const activeOrders = ids.filter((id) => rules[id].Status !== 'Removed').map((id) => rules[id].Order);
    if (new Set(activeOrders).size !== activeOrders.length) { dupOrders++; console.log('     duplicate Order in', path.basename(file)); }
    for (const id of ids) {
      const r = rules[id];
      if (HTML_ENTITY.test(r.ValidationCriteria.MustSatisfy)) { entities++; console.log('     HTML entity in MustSatisfy', id, 'in', path.basename(file)); }
      if (r.Status === 'Removed') continue;
      for (const d of r.ValidationCriteria.Dependencies) {
        if (!allIds.has(d)) { dangling++; console.log('     unresolved dep', id, '->', d, 'in', path.basename(file)); }
        else if (removedIds.has(d)) warn(`active rule ${id} references removed rule ${d}`);
      }
      if (r.Function === 'Composite') {
        // Items must appear in Dependencies IN ORDER, not necessarily first: Dependencies carries
        // extra edges (a column root also depends on the dataset rule requiring that column, placed
        // among the children by its Order) and legitimately holds non-CheckModelRule entries.
        const items = (r.ValidationCriteria.Requirement.Items || []).map((i) => i.ModelRuleId);
        const deps = r.ValidationCriteria.Dependencies;
        let at = 0;
        for (const item of items) {
          const found = deps.indexOf(item, at);
          if (found === -1) { at = -1; break; }
          at = found + 1;
        }
        if (at === -1) {
          inconsistent++;
          console.log('     Composite Items are not an ordered subsequence of Dependencies', id);
        }
      }
      // A rule that evaluates another through CheckModelRule depends on it, so every ModelRuleId
      // named by the Requirement or the Condition has to be declared in Dependencies.
      for (const ref of modelRuleRefs(r.ValidationCriteria.Requirement).concat(modelRuleRefs(r.ValidationCriteria.Condition))) {
        if (!r.ValidationCriteria.Dependencies.includes(ref)) {
          undeclared++;
          console.log('     ModelRuleId not in Dependencies', id, '->', ref, 'in', path.basename(file));
        }
      }
      // The synthesized columns composite states no requirement of its own, so its sentence carries
      // no BCP-14 keyword to match against; the model records it as MUST.
      const kw = r.ValidationCriteria.MustSatisfy.match(/\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY)\b/);
      const synthesized = id === columnsCompositeId(rules);
      if (synthesized ? r.ValidationCriteria.Keyword !== 'MUST' : (!kw || kw[1] !== r.ValidationCriteria.Keyword)) {
        inconsistent++;
        console.log('     Keyword mismatch', id);
      }
    }
  }
  check(true, `Scanned ${files.length} output files`);
  check(dupIds === 0, 'No duplicate Rule IDs in any file');
  check(dupNums === 0, 'No duplicate NumericIds in any file');
  check(unsorted === 0, 'Every file sorted by NumericId');
  check(dangling === 0, 'Active-rule dependencies resolve across all generated files (incl. ATT-*)');
  check(inconsistent === 0, 'Composite Items lead Dependencies and Keyword==MustSatisfy keyword');
  check(entities === 0, 'No raw HTML entities in MustSatisfy (entity-decode regression guard)');
  check(prefixMismatch === 0, 'Dataset/column rules carry DatasetType and an ID prefixed with it');
  check(undeclared === 0, 'Every CheckModelRule ModelRuleId in a Requirement/Condition is declared in Dependencies');
  check(dupOrders === 0, 'No two active rules in an entity share an Order');
}

// --- Layer 2: Active baseline rules the extract no longer carries ------------
/**
 * Every rule that is Active in the baseline but not Active in the output, across all entities.
 *
 * Reuse matches on exact MustSatisfy text, so a sentence that was merely reworded, retitled, or
 * reformatted reads as a removal plus an unrelated new rule. That churns rule IDs for a
 * requirement that never actually went away, and it is invisible in the extractor's own output.
 * Three buckets, because the causes differ:
 *   tombstoned    - the id survives with Status "Removed"; the normal removal path, so each one is
 *                   warned rather than failed: only an editor can say whether the removal was meant.
 *   not generated - the baseline entity has Active rules but no generated file at all, because the
 *                   extractor does not yet expand that entity kind (objects, conditions). A
 *                   coverage gap in the extractor, so it is reported per entity, not per rule.
 *   absent        - the id is gone from a file that WAS generated, which the extractor only does
 *                   for a rule introduced in the unpublished NEW_VERSION. Anything else is a defect.
 */
function droppedActiveAudit(check, warn, silent) {
  const baselineRoot = path.join(BASELINE_ROOT, 'model_rules');

  let absent = 0, tombstoned = 0, activeTotal = 0;
  // Entity kinds with no generated counterpart at all, tallied per kind (the folder the entity
  // sits in) so one warning covers each coverage gap rather than one per orphaned rule.
  const ungenerated = new Map();
  for (const file of walkFiles(baselineRoot)) {
    const rel = path.relative(baselineRoot, file);
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    const active = Object.values(baseline).filter((r) => r.Status === 'Active').length;
    activeTotal += active;

    const outPath = path.join(OUTPUT_ROOT, rel);
    if (!fs.existsSync(outPath)) {
      // A fully tombstoned entity (every rule Removed) is dead, not a coverage gap: the markdown
      // no longer defines it, so having no generated file is the correct outcome.
      if (!active) continue;
      const parts = rel.split(path.sep);
      const kind = parts.length > 1 ? parts[parts.length - 2] : parts[0];
      const seen = ungenerated.get(kind) || { entities: 0, active: 0, files: [] };
      seen.entities++; seen.active += active; seen.files.push(rel);
      ungenerated.set(kind, seen);
      continue;
    }
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    const rows = [];
    for (const [id, rule] of Object.entries(baseline)) {
      if (rule.Status !== 'Active') continue;
      const now = out[id];
      if (now && now.Status !== 'Removed') continue;
      if (now) { tombstoned++; rows.push([id, 'tombstoned', rule]); continue; }
      // Dropping an unpublished rule outright is intended; anything older had to be tombstoned.
      if (rule.ModelVersionIntroduced === NEW_VERSION) continue;
      absent++;
      rows.push([id, 'ABSENT', rule]);
    }
    if (rows.length && !silent) {
      console.log(`     ${rel}`);
      for (const [id, bucket, rule] of rows) {
        console.log(`       ${id}  [${bucket}]  "${rule.ValidationCriteria.MustSatisfy.slice(0, 96)}"`);
      }
    }
  }

  if (!silent) {
    for (const [kind, g] of [...ungenerated].sort()) {
      console.log(`     ${kind}/: not generated, ${g.entities} baseline entit${g.entities === 1 ? 'y' : 'ies'}, ${g.active} Active rule(s)`);
      for (const f of g.files.sort()) console.log(`       ${f}`);
    }
  }

  check(absent === 0, `[dropped] Active baseline rules are tombstoned, never deleted (${activeTotal} Active scanned)`);
  for (const [kind, g] of [...ungenerated].sort()) {
    warn(`${kind}/ has no generated counterpart: ${g.entities} baseline entit${g.entities === 1 ? 'y' : 'ies'} (${g.active} Active rule(s)) missing from the extract`);
  }
  if (tombstoned) warn(`${tombstoned} Active baseline rule(s) come back tombstoned: confirm each removal is intended, not a reworded sentence that lost its ID`);
}

// --- Layer 2b: curation defaults on rules with no baseline ------------------

/**
 * A "When ..." clause that names columns and literals, e.g.
 *   When AllocatedResourceId is not null,
 *   When ChargeCategory is "Usage" or "Purchase" and CommitmentDiscountId is not null,
 * Parsed only to decide whether a machine-checkable Condition is expected; the Condition itself is
 * curated in the model, never derived here. A clause stating a circumstance in prose ("When the
 * charge is not associated with an invoice") does not parse, and correctly expects nothing.
 */
function parseWhenClause(mustSatisfy, columnIds) {
  const m = /^When ([^,]+),/.exec(mustSatisfy || '');
  if (!m) return null;
  const terms = m[1].split(/ and | or /);
  const parsed = [];
  for (const term of terms) {
    const t = /^([A-Z][A-Za-z0-9]*) is (not )?(null|"[^"]*")$/.exec(term.trim());
    if (!t) return null;            // one unparseable term makes the whole clause prose
    if (!columnIds.has(t[1])) return null;
    parsed.push(t[1]);
  }
  return parsed;
}

/**
 * Report the curated fields left at their defaults on rules the baseline does not hold.
 *
 * A rule that reuses a baseline id inherits its curation, so it is right by construction. A brand
 * new rule gets whatever the derivation can produce, and the gaps it cannot fill are indistinguishable
 * from deliberate choices: an empty Requirement, an empty Condition, and the AND that every composite
 * defaults to are all schema-valid and pass every model test. They are listed here so each one is
 * reviewed once, rather than being discovered later as a rule that quietly checks nothing.
 *
 * The one hard failure is a rule whose sentence states a machine-checkable "When ..." clause and
 * carries no Condition: the clause names columns and literals, so a Condition is expected.
 */
function newRuleCurationAudit(check, warn) {
  const baselineRoot = path.join(BASELINE_ROOT, 'model_rules');
  const baselineIds = new Set();
  if (fs.existsSync(baselineRoot)) {
    for (const file of walkFiles(baselineRoot)) {
      for (const id of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))) baselineIds.add(id);
    }
  }

  const rules = {};
  for (const file of walkFiles(OUTPUT_ROOT)) Object.assign(rules, JSON.parse(fs.readFileSync(file, 'utf8')));
  const columnIds = new Set(
    Object.values(rules)
      .filter((r) => r.EntityType === 'Column' || r.EntityType === 'Object')
      .map((r) => r.EntityId)
  );

  const defaulted = [];
  let missingCondition = 0;
  for (const id of Object.keys(rules).sort()) {
    const rule = rules[id];
    if (rule.Status === 'Removed') continue;
    const vc = rule.ValidationCriteria;

    // Applies to every rule, new or not: a parseable clause always expects a Condition.
    if (!Object.keys(vc.Condition || {}).length && parseWhenClause(vc.MustSatisfy, columnIds)) {
      missingCondition++;
      console.log('     conditional sentence with no Condition', id);
      console.log(`       "${vc.MustSatisfy}"`);
    }

    if (baselineIds.has(id)) continue;
    const gaps = [];
    if (!Object.keys(vc.Requirement || {}).length) gaps.push('Requirement empty');
    if (!Object.keys(vc.Condition || {}).length) {
      gaps.push(/\bwhen\b/i.test(vc.MustSatisfy) ? 'Condition empty (conditional sentence)' : 'Condition empty');
    }
    if (rule.Function === 'Composite' && (vc.Requirement || {}).CheckFunction === 'AND') {
      gaps.push('operator AND (default)');
    }
    if (gaps.length) defaulted.push({ id, gaps });
  }

  check(missingCondition === 0, 'Rules stating a machine-checkable "When ..." clause carry a Condition');

  if (defaulted.length) {
    warn(`${defaulted.length} rule(s) are new in this run and carry default curation; review each before publishing:`);
    for (const d of defaulted) warn(`     ${d.id.padEnd(46)} ${d.gaps.join(', ')}`);
  }
}

// --- Layer 3: deep transformation audit of the dataset file ------------------
function datasetAudit(check) {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const reqHeading = contract.Datasets.Headings.Requirements;
  const out = JSON.parse(fs.readFileSync(path.join(OUTPUT_ROOT, 'datasets', DATASET_FOLDER, datasetJsonName(DATASET_FOLDER)), 'utf8'));

  const baselineDir = path.join(BASELINE_ROOT, 'model_rules', 'datasets', DATASET_FOLDER);
  const baseline = {};
  if (fs.existsSync(baselineDir)) for (const f of fs.readdirSync(baselineDir)) if (f.endsWith('.json')) Object.assign(baseline, JSON.parse(fs.readFileSync(path.join(baselineDir, f), 'utf8')));

  const md = fs.readFileSync(path.join(specPath(SPEC_ROOT, contract.Datasets.Location), DATASET_FOLDER, 'dataset.md'), 'utf8');
  const tokens = marked.lexer(md);
  const body = (() => { const i = tokens.findIndex((t) => t.type === 'heading' && t.text.replace(/<!--.*?-->/g, '').trim() === reqHeading); const b = []; for (let j = i + 1; j < tokens.length; j++) { if (tokens[j].type === 'heading') break; b.push(tokens[j]); } return b; })();
  const expected = new Set([normalize(renderInline(body.find((t) => t.type === 'paragraph').tokens))]);
  (function walk(list) { for (const it of list.items) { const tt = it.tokens.find((t) => t.type === 'text'); expected.add(normalize(renderInline(tt.tokens))); const sub = it.tokens.find((t) => t.type === 'list'); if (sub) walk(sub); } })(body.find((t) => t.type === 'list'));

  const baseByText = new Map(); let baselineMax = -1;
  for (const id of Object.keys(baseline)) { baseByText.set(normalize(baseline[id].ValidationCriteria.MustSatisfy), id); baselineMax = Math.max(baselineMax, numericIdOf(id)); }

  // The columns composite is synthesized from the dataset's columns, not from a sentence, so it is
  // held out of every markdown-derived comparison below and checked on its own terms.
  const compositeId = columnsCompositeId(out);
  const active = {};
  for (const id of Object.keys(out)) if (out[id].Status !== 'Removed' && id !== compositeId) active[id] = out[id];
  const activeTexts = new Set(Object.values(active).map((r) => normalize(r.ValidationCriteria.MustSatisfy)));

  check(activeTexts.size === expected.size && [...expected].every((t) => activeTexts.has(t)),
    `[dataset] Active rules cover exactly the ${expected.size} markdown requirements (got ${activeTexts.size})`);

  let idIssues = 0;
  for (const id of Object.keys(active)) {
    const t = normalize(active[id].ValidationCriteria.MustSatisfy);
    if (baseByText.has(t)) { if (id !== baseByText.get(t)) idIssues++; }
    else if (numericIdOf(id) <= baselineMax) idIssues++;
  }
  check(idIssues === 0, `[dataset] Reused IDs match baseline; new IDs above baseline max (${baselineMax})`);

  // The columns composite keeps the baseline's id and sentence, and lists exactly the column roots
  // of this dataset, one per column markdown file.
  if (compositeId) {
    const columnDir = path.join(specPath(SPEC_ROOT, contract.Datasets.Location), DATASET_FOLDER, 'columns');
    const columnCount = fs.existsSync(columnDir) ? fs.readdirSync(columnDir).filter((f) => f.endsWith('.md')).length : 0;
    const composite = out[compositeId];
    const baselineComposite = baseline[compositeId];
    check(
      composite.ValidationCriteria.Dependencies.length === columnCount
        && composite.Order === -1
        && (!baselineComposite || normalize(composite.ValidationCriteria.MustSatisfy) === normalize(baselineComposite.ValidationCriteria.MustSatisfy)),
      `[dataset] Columns composite ${compositeId} covers all ${columnCount} columns`);
  }

  let versionIssues = 0;
  for (const id of Object.keys(active)) {
    const t = normalize(active[id].ValidationCriteria.MustSatisfy);
    const want = baseByText.has(t) ? baseline[baseByText.get(t)].ModelVersionIntroduced : NEW_VERSION;
    if (active[id].ModelVersionIntroduced !== want) versionIssues++;
  }
  check(versionIssues === 0, '[dataset] ModelVersionIntroduced correct (reused vs new)');

  // A baseline rule introduced in NEW_VERSION never shipped, so dropping it beats tombstoning
  // the removal of something no consumer saw. Anything older must be tombstoned.
  const unpublished = (id) => baseline[id].ModelVersionIntroduced === NEW_VERSION;

  let tombIssues = 0, dropIssues = 0;
  for (const id of Object.keys(baseline)) {
    const t = normalize(baseline[id].ValidationCriteria.MustSatisfy);
    if (expected.has(t) || id === compositeId) continue;
    if (unpublished(id)) { if (out[id]) dropIssues++; continue; }
    if (!out[id]) { tombIssues++; continue; }
    if (baseline[id].Status === 'Removed') { if (JSON.stringify(out[id]) !== JSON.stringify(renameConditions(JSON.parse(JSON.stringify(baseline[id]))))) tombIssues++; }
    else if (out[id].Status !== 'Removed' || out[id].ModelVersionRemoved !== NEW_VERSION) tombIssues++;
  }
  check(tombIssues === 0, '[dataset] Unmatched baseline rules tombstoned (already-removed carried unchanged)');
  check(dropIssues === 0, `[dataset] Unmatched baseline rules introduced in ${NEW_VERSION} dropped, not tombstoned`);

  const expectedIds = new Set([...Object.keys(active), ...(compositeId ? [compositeId] : []), ...Object.keys(baseline).filter((id) => !expected.has(normalize(baseline[id].ValidationCriteria.MustSatisfy)) && !unpublished(id))]);
  const outIds = new Set(Object.keys(out));
  check(expectedIds.size === outIds.size && [...outIds].every((id) => expectedIds.has(id)), '[dataset] Output = derived-active ∪ tombstones (no orphans)');
}

const USAGE = `Usage: node verify.js [options]

Options:
  --specification <folder>  Specification markdown the output was extracted from.
                            Default: ${DEFAULT_SPEC_ROOT}.
  --baseline <folder>       Baseline release the output was extracted against.
                            Default: releases/${BASELINE_DIR}.
  --output <folder>         Generated model to audit. Default: the extractor's own
                            output/ folder.
  -h, --help                Show this message.

All three must name the folders the extract run used. Folders may be relative to the
working directory. Environment: BASELINE_DIR, NEW_VERSION, DATASET_FOLDER.`;

/**
 * Run all checks. Returns { pass, fail, warnings }. Logs each check unless silent.
 *
 * The three folder options mirror extract_rm.js's flags; the test suite passes its fixture
 * tree this way rather than through argv.
 */
function runVerify({ silent = false, specification, baseline, output } = {}) {
  if (specification) SPEC_ROOT = path.resolve(specification);
  if (baseline) BASELINE_ROOT = path.resolve(baseline);
  if (output) OUTPUT_ROOT = path.join(path.resolve(output), 'model_rules');
  NEW_VERSION = process.env.NEW_VERSION || baselineModelVersion();

  if (!fs.existsSync(OUTPUT_ROOT)) {
    throw new UsageError(`No generated model at ${OUTPUT_ROOT}\nRun the extractor first, or pass --output <folder>.`);
  }

  let pass = 0, fail = 0;
  const warnings = [];
  const check = (ok, msg) => { if (!silent) console.log((ok ? '✅' : '❌') + ' ' + msg); ok ? pass++ : fail++; };
  const warn = (msg) => warnings.push(msg);
  structuralChecks(check, warn);
  droppedActiveAudit(check, warn, silent);
  newRuleCurationAudit(check, warn);
  datasetAudit(check);
  if (!silent) {
    if (warnings.length) {
      console.log(`\n⚠ ${warnings.length} warning(s):`);
      for (const w of warnings) console.log('   ' + w);
    }
    console.log(`\n${pass} checks passed, ${fail} failed, ${warnings.length} warning(s).`);
  }
  return { pass, fail, warnings };
}

function main() {
  const opts = parseArgs(process.argv.slice(2), ['specification', 'baseline', 'output']);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { fail } = runVerify(opts);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) runMain(main, USAGE);

module.exports = { runVerify };
