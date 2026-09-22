#!/usr/bin/env node
'use strict';

/**
 * Requirements Model extractor.
 *
 * Generates Requirements Model JSON from FOCUS specification markdown, driven by
 * `requirements_model_contract.json`. Markdown is parsed into an AST (via the
 * `marked` lexer) and the nested bullet list under each entity's `## Requirements`
 * heading is expanded into a rule family (a root composite, sub-composites, and a
 * rule per leaf bullet).
 *
 * Entity scope: DataModel (data_model.md), Attributes (attributes/*.md), Conditions
 * (operating_model_conditions/*.md), Datasets (<dataset>/dataset.md), Columns
 * (<dataset>/columns/*.md), and the Objects nested inside a JSON-object column's markdown. Each entity is written
 * to its own file, mirroring the releases/<v>/model_rules/ tree, under ./output/model_rules/.
 *
 * Rule IDs are <DatasetType>-<ArtifactName>-<ArtifactType>-<NumericId>-<Status>
 * for dataset-scoped entities (DatasetType prefix from the contract's DatasetTypes
 * map) and <ArtifactName>-<ArtifactType>-<NumericId>-<Status> otherwise (e.g. the
 * data model). IDs are STABLE: existing IDs are read from the baseline model in
 * releases/latest and reused when a derived rule's MustSatisfy exactly matches an Active
 * baseline rule; anything else (no match, or a match against only a non-Active baseline
 * rule) takes the next free NumericId as a new rule; baseline rules absent from the
 * markdown are tombstoned (Status "Removed"). Status (M/O/C) is derived from the keyword
 * and conditional phrasing.
 *
 * Leaf classification: composites become an AND over their children; "MUST include"
 * becomes a presence rule (ColumnPresent for datasets); leaves whose sentence matches
 * the per-release check-function lookup get a populated domain Requirement
 * (Type/Format/Nullability/...); "MUST conform to <Attr>" leaves link the attribute
 * via Dependencies; any remaining leaf is emitted with an empty Requirement, and is
 * recorded as a warning so the lookup can be extended unless it reused an Active previous
 * rule that was itself curated as Dynamic, in which case it is accepted as-is.
 * A populated Requirement is Static, an empty one Dynamic.
 * Conditions are resolved from `#operatingmodelconditions.<anchor>`
 * links to their Condition IDs.
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { renderInline, normalizeHeading, datasetJsonName, resolveDatasetFolders, renameConditions } = require('./markdown_util');
const { DEFAULT_SPEC_ROOT, UsageError, parseArgs, specPath, runMain } = require('./cli');

// Root of the specification markdown. --specification points it anywhere; resolved in main().
let SPEC_ROOT = DEFAULT_SPEC_ROOT;
const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const CONTRACT_PATH = path.join(__dirname, 'requirements_model_contract.json');
const CHECK_LOOKUP_PATH = path.join(__dirname, 'check_function_lookup.json');
// Where the generated model is written. Defaults to ./output next to this script; `--output
// <folder>` moves the whole tree, model_rules/ and the copied release assets alike. Resolved in
// main() so that merely requiring this module (the tests do) never reads argv.
let OUTPUT_DIR = path.join(__dirname, 'output');
let OUTPUT_ROOT = path.join(OUTPUT_DIR, 'model_rules');
// Per-release model inputs that no markdown expresses: the check-function catalog, the condition
// and dataset registries, the model schema, and the JSON Schemas referenced by rules. They are
// copied from the baseline release so the output folder builds as a complete model.
const RELEASE_ASSETS = ['model_details.json', 'check_functions.json', 'conditions.json', 'applicability_criteria.json', 'model_datasets.json', 'model_schema.json', 'json_schemas'];

// The baseline is always the `latest` release directory: extraction compares the current
// branch's markdown against the most recently published model, so corrections made there are
// picked up without touching this file. BASELINE_DIR overrides it for a one-off diff against
// an older release (e.g. BASELINE_DIR=1.4), and `--baseline <folder>` overrides it with a path
// to any baseline folder, wherever it lives.
const BASELINE_DIR = process.env.BASELINE_DIR || 'latest';

// The baseline folder to read, and the label naming it in console output. BASELINE_DIR names a
// folder under releases/; --baseline takes a path (relative ones resolve against the working
// directory), so the label is kept separately rather than reconstructed from a path segment.
let BASELINE_ROOT = path.join(RELEASES_DIR, BASELINE_DIR);
let BASELINE_LABEL = `releases/${BASELINE_DIR}`;

// Version labels, resolved from the baseline's model_details.json in main(). PREVIOUS_VERSION
// is for reporting only; NEW_VERSION is stamped into ModelVersionIntroduced/Removed. The
// branch is the working draft of the version `latest` holds, so both resolve to it and new
// rules are introduced in the version being drafted. NEW_VERSION overrides for a version bump.
let PREVIOUS_VERSION = BASELINE_DIR;
let NEW_VERSION = process.env.NEW_VERSION || BASELINE_DIR;

// Ordered so multi-word variants win over their prefixes (e.g. "MUST NOT" before "MUST").
const BCP14_KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY)\b/;
// A presence bullet names one column after the keyword; the obligation strength (MUST /
// SHOULD / MAY) is carried by the rule's Keyword and Rule-ID status letter, not by whether
// it is a presence rule at all. The capture requires a PascalCase identifier so that prose
// "include" sentences (e.g. "MUST include custom columns", "MUST include separate charges",
// "MUST include all tag keys") are not read as a column name; those fall through to the
// unclassified path. Link text renders to the bare id, so "[Tags](#...)" matches.
const INCLUDE_RE = /\b(?:MUST|SHOULD|MAY) include ([A-Z]\w*)\b/;
const CONFORM_RE = /MUST conform to (\w+) requirements/;
// A leaf rule's Function names what its sentence is about, and two of those namings are readable
// straight off the sentence: one about whether a value may be null is Nullability, and one about
// the shape a value takes is Format. Both conventions hold for every rule in the published model,
// and the specification's own model suite asserts them, so a leaf the check-function lookup did
// not map is named this way rather than falling to a blanket 'Validation'.
const NULLABILITY_RE = /be null/i;
const FORMAT_RE = /\bformat\b/i;
// Entity types whose "MUST include <X>" sentences assert that a contained artifact is present.
const PRESENCE_ENTITY_TYPES = new Set(['Dataset', 'DataModel']);
const CONDITIONAL_RE = /\bwhen\b/;
// A column's root rule, the one every other rule about that column hangs off.
const C000_RE = /-C-000-/;
// Words that put a requirement under scope: it binds only in the circumstances they introduce.
const SCOPE_WORDS = ['when', 'unless', 'where', 'if it'];
// Fragments where those words are part of the requirement's own prose rather than a scope clause
// (an inline example, a variable definition), so a rule carrying one is not conditional.
const SCOPE_EXCLUSIONS = [
  'sla credit details when the credit is already applied',
  '(e.g., when the',
  'where necessary',
  ', where quantity is a positive integer,',
  'where m is a real number and n',
  'when required for a decimal value',
];

// Loaded once in main(): the per-release sentence -> check-function lookup, the
// condition anchor -> ConditionId map, and a dedup'd set of unmapped sentences.
let CHECK_LOOKUP = {};
let CONDITIONS = {};
// Every Condition ID the spec defines, for validating ids on emitted rules.
let CONDITION_IDS = new Set();
// EntityId -> Display Name for every entity the spec defines, collected before any rule is built.
// A rule that references another entity (a dataset's presence rule naming a column) must record
// that entity's real display name; splitting the PascalCase id would mangle initialisms
// ("BillingAccountId" -> "Billing Account Id", where the spec writes "Billing Account ID").
let DISPLAY_NAMES = {};
const WARNINGS = [];
// Lookup sentences the baseline release redefines, overriding the extractor's own mapping.
const LOOKUP_OVERRIDES = [];
// Lookup sentences read in the pre-1.6 `{ function, requirement }` shape and converted on load.
const LEGACY_LOOKUP_ENTRIES = [];
// Lookup sentences this run actually matched. The lookup is a superset of patterns covering
// every dataset; only the ones a run consumes say anything about that run's release.
const USED_LOOKUP_KEYS = new Set();
// Leaves with no derivable check function that matched an Active baseline rule already
// curated as Dynamic: accepted, not warned about, but counted so the tally stays visible.
const ACCEPTED_DYNAMIC = [];
// Baseline rules introduced in NEW_VERSION and no longer in the markdown: dropped from the
// output rather than tombstoned, and reported because the baseline copy needs deleting.
const UNPUBLISHED_REMOVALS = [];
// Rules whose baseline Order sits at or below the preceding rule's, so the baseline disagrees
// with the markdown about where they belong. Renumbered here and reported.
const ORDER_CONFLICTS = [];
// Condition ids on an emitted rule that no conditions markdown file defines: a dangling reference,
// whether it came from a sentence anchor or was carried from the baseline.
const UNKNOWN_CONDITIONS = [];
const EMITTED = []; // { outPath, rules } per file, written after the carry-forward post-pass
// Baseline entities with no markdown left: carried forward as all-tombstone files, and reported.
const REMOVED_ENTITIES = [];
// Composites whose operator (AND/OR) came from the baseline rather than the derivation.
const CARRIED_OPERATORS = [];
// Entities the markdown marks deprecated; their rules are emitted with Status "Deprecated".
const DEPRECATED_ENTITIES = [];
// Rules whose Condition was carried from the baseline on its own (no Requirement adoption).
const CARRIED_CONDITIONS = [];

// ---------------------------------------------------------------------------
// Text / id helpers
// ---------------------------------------------------------------------------

/** Split a PascalCase id into a spaced Display Name (e.g. "BillingPeriodEnd" -> "Billing Period End"). */
function pascalToDisplay(id) {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Map a BCP-14 keyword to a Rule-ID status letter (M=Mandatory, O=Optional, C=Conditional). */
function statusLetter(keyword, hasCondition) {
  if (hasCondition) return 'C';
  if (keyword === 'SHOULD' || keyword === 'SHOULD NOT' || keyword === 'MAY') return 'O';
  return 'M';
}

/** Whether a sentence states the circumstances a requirement binds in, rather than binding always. */
function textHasScope(text) {
  if (typeof text !== 'string') return false;
  let s = text.toLowerCase();
  for (const phrase of SCOPE_EXCLUSIONS) s = s.split(phrase).join('');
  return SCOPE_WORDS.some((w) => s.includes(w));
}

/** Whether a built rule is scoped: gated by conditions, or worded conditionally. */
function ruleHasScope(rule) {
  const vc = rule.ValidationCriteria || {};
  return (rule.Conditions || []).length > 0
    || Object.keys(vc.Condition || {}).length > 0
    || textHasScope(vc.MustSatisfy);
}

/**
 * The status letter a finished rule should carry, from the model's convention:
 *
 *   * A scoped rule is Conditional, as is a composite every one of whose evaluated rules is scoped
 *     (it can only bind when one of them does).
 *   * Otherwise a composite takes the strength of the presence rules it depends on, since that is
 *     what decides whether the artifact has to be there at all.
 *   * Otherwise the BCP-14 keyword decides: MUST is Mandatory, the softer keywords Optional.
 *
 * The letter cannot be settled when a rule id is first assigned: a composite's children are not
 * built yet, and conditions carried from a column are attached later still. Rules introduced in
 * this run are therefore renumbered against this function once everything is in place.
 */
function statusLetterFor(rule, allRules) {
  if (ruleHasScope(rule)) return 'C';
  const vc = rule.ValidationCriteria || {};
  const keyword = (vc.Keyword || '').toUpperCase();

  if (rule.Function === 'Composite') {
    const refs = modelRuleRefs(vc.Requirement || {});
    if (refs.length && refs.every((id) => allRules[id] && ruleHasScope(allRules[id]))) return 'C';
    const presence = (vc.Dependencies || [])
      .map((id) => allRules[id])
      .filter((dep) => dep && dep.Function === 'Presence');
    if (presence.some((dep) => (dep.ValidationCriteria.Keyword || '').toUpperCase() === 'MUST')) return 'M';
    if (presence.length) return 'O';
  }

  return keyword === 'MUST' || keyword === 'MUST NOT' ? 'M' : 'O';
}

/** Build a Rule ID. `ctx.idPrefix` (DatasetType for datasets/columns, "ATT" for attributes) is optional. */
function buildRuleId(ctx, numericId, status) {
  const padded = String(numericId).padStart(3, '0');
  const prefix = ctx.idPrefix ? `${ctx.idPrefix}-` : '';
  return `${prefix}${ctx.artifactName}-${ctx.artifactType}-${padded}-${status}`;
}

/**
 * The root composite of an emitted entity: the Active rule at Order 0. Selected by Order rather
 * than by NumericId 0, because a reworded root sentence leaves a tombstone holding NumericId 0
 * while the live root takes a fresh number, and conformance must never link to a Removed rule.
 */
function rootRuleId(rules) {
  return Object.keys(rules).find((k) => rules[k].Status !== 'Removed' && rules[k].Order === 0);
}

/** Parse the artifact name out of a Rule ID (e.g. "BIP-BillingPeriod-D-004-M" -> "BillingPeriod"). */
function entityOfRuleId(ruleId) {
  const m = ruleId.match(/^(?:[A-Za-z0-9]{3}-)?(.+)-[A-Z]-\d{3}-[A-Z]$/);
  return m ? m[1] : null;
}

/** Parse the NumericId out of a Rule ID (e.g. "BIP-BillingPeriod-D-004-M" -> 4). */
function numericIdOf(ruleId) {
  const m = ruleId.match(/-(\d+)-[A-Z]$/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Normalize MustSatisfy text for cross-version matching: strip inline-code backticks
 * (the extractor emits plain text, but older baselines stored the markdown backticks),
 * then trim and collapse whitespace. Applied to both sides of a comparison, so it only
 * affects ID reuse, never the stored MustSatisfy value.
 */
function normalizeMustSatisfy(text) {
  return text.replace(/`/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * Every ModelRuleId named inside a Requirement or Condition, in traversal order. Nested
 * CheckModelRule entries (an AND whose Items are themselves composites) are included.
 */
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

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

/**
 * A contract heading, as the list of spellings that satisfy it.
 *
 * A heading may be written as a list of alternates, newest spelling first, so one extractor
 * reads an entity across a rename ("Condition ID" -> "Operating Model Condition ID") and still
 * resolves an older branch or release tag. A bare string is the single-spelling case.
 */
function headingSpellings(heading) {
  return Array.isArray(heading) ? heading : [heading];
}

/** How a heading reads in an error message: every spelling that would have satisfied it. */
function headingLabel(heading) {
  return headingSpellings(heading).join('" or "');
}

/** Body tokens of the H2 section introduced by `heading` (a spelling, or a list of them). */
function getSectionTokens(tokens, heading, depth = 2) {
  const spellings = headingSpellings(heading);
  const start = tokens.findIndex(
    (t) => t.type === 'heading' && t.depth === depth && spellings.includes(normalizeHeading(t.text))
  );
  if (start === -1) throw new Error(`Heading not found: "${headingLabel(heading)}" (depth ${depth})`);
  const body = [];
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'heading' && tokens[i].depth <= depth) break;
    body.push(tokens[i]);
  }
  return body;
}

/** Whether an H2 section with the given heading text exists (used to skip overview files). */
function hasSection(tokens, heading, depth = 2) {
  const spellings = headingSpellings(heading);
  return tokens.some((t) => t.type === 'heading' && t.depth === depth && spellings.includes(normalizeHeading(t.text)));
}

/** Plain text of the first paragraph token in a section (a simple-value or anchor line). */
function getSectionText(tokens, heading, depth = 2) {
  const paragraph = getSectionTokens(tokens, heading, depth).find((t) => t.type === 'paragraph');
  if (!paragraph) throw new Error(`No paragraph found in section "${headingLabel(heading)}"`);
  return renderInline(paragraph.tokens);
}

/** Match a condition link href, e.g. "#operatingmodelconditions.includesregions". */
function conditionAnchorRe(prefixes) {
  return new RegExp(`^#(?:${prefixes.join('|')})\\.(.+)$`);
}

// The anchor prefixes condition links are written with. Both spellings are accepted so a rename
// of the folder does not silently drop every condition from the rules that are gated on one;
// main() replaces this with the contract's AnchorPrefixes.
let CONDITION_ANCHOR_RE = conditionAnchorRe(['operatingmodelconditions', 'conditions']);

/** Collect condition anchors from inline tokens (links whose href is a condition anchor). */
function conditionAnchorsOf(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === 'link' && t.href) {
      const m = t.href.match(CONDITION_ANCHOR_RE);
      if (m) out.push(m[1]);
    }
    if (t.tokens) out.push(...conditionAnchorsOf(t.tokens));
  }
  return out;
}

/** Parse a `list` token's items into a tree of { text, children, conditionAnchors }. */
function parseListItems(listToken) {
  return listToken.items.map((item) => {
    const textToken = item.tokens.find((t) => t.type === 'text');
    const subList = item.tokens.find((t) => t.type === 'list');
    return {
      text: textToken ? renderInline(textToken.tokens) : '',
      conditionAnchors: textToken ? conditionAnchorsOf(textToken.tokens) : [],
      children: subList ? parseListItems(subList) : [],
    };
  });
}

/**
 * Whether an entity's markdown marks it deprecated.
 *
 * A deprecated entity is not deleted from the spec: it keeps its Requirements and gains a
 * "## Deprecated (version)" section naming the version that deprecated it (and usually a
 * replacement), with "- DEPRECATED" appended to its title. Its rules therefore still derive
 * normally; only their Status changes, so consumers can see the obligation and its lifecycle at
 * once. An empty or absent section means the entity is current.
 */
function isDeprecatedEntity(tokens, headings, depth = 2) {
  if (!headings.Deprecated || !hasSection(tokens, headings.Deprecated, depth)) return false;
  const body = getSectionTokens(tokens, headings.Deprecated, depth);
  const paragraph = body.find((t) => t.type === 'paragraph');
  return Boolean(paragraph && renderInline(paragraph.tokens).trim());
}

/** Build the requirement tree for an entity: a root composite over its top-level bullets. */
function parseRequirementTree(tokens, requirementsHeading, depth = 2) {
  const body = getSectionTokens(tokens, requirementsHeading, depth);
  const anchor = body.find((t) => t.type === 'paragraph');
  const list = body.find((t) => t.type === 'list');
  if (!anchor || !list) throw new Error('Requirements section missing anchor paragraph or bullet list.');
  return { text: renderInline(anchor.tokens), conditionAnchors: conditionAnchorsOf(anchor.tokens), children: parseListItems(list) };
}

/** Flatten a requirement tree into a pre-order array of { node, text, childIdx[] } specs. */
function flattenTree(root) {
  const specs = [];
  (function visit(node) {
    const idx = specs.length;
    specs.push({ node, text: node.text, childIdx: [] });
    for (const child of node.children) specs[idx].childIdx.push(visit(child));
    return idx;
  })(root);
  return specs;
}

// ---------------------------------------------------------------------------
// Rule construction
// ---------------------------------------------------------------------------

/**
 * Resolve a sentence against the check-function lookup; null when unmapped.
 *
 * A lookup value is a fragment of a rule, written in the same shape a rule has, so whatever keys
 * an entry defines are applied to the emitted rule verbatim. Returns the fragment with every
 * `{entity}` placeholder replaced by the artifact name.
 */
function checkFunctionFor(text, artifactName) {
  const norm = text.split(artifactName).join('{entity}');
  const entry = CHECK_LOOKUP[norm];
  if (!entry) return null;
  USED_LOOKUP_KEYS.add(norm);
  return JSON.parse(JSON.stringify(entry).split('{entity}').join(artifactName));
}

/** Deep-merge `patch` over `base`: objects merge key by key, arrays and scalars replace. */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return JSON.parse(JSON.stringify(patch));
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : JSON.parse(JSON.stringify(v));
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The Function for a sentence no check-function mapping covers.
 *
 * Nullability is tested first: a sentence saying something "be null" states nullability directly,
 * while "format" can appear inside such a sentence. A sentence answering to both conventions
 * cannot satisfy them at once, so one of them has to be the reading.
 */
function functionForSentence(text) {
  if (NULLABILITY_RE.test(text)) return 'Nullability';
  if (FORMAT_RE.test(text)) return 'Format';
  return 'Validation';
}

/**
 * Classify a requirement node into Function / Reference / Requirement / Dependencies.
 * Type is derived later from whether Requirement is populated. Leaf order matters:
 * composite -> include -> check-function lookup -> attribute conformance -> unclassified.
 */
function classify(node, childKeys, ctx) {
  if (node.children.length) {
    return {
      Function: 'Composite',
      Reference: ctx.artifactName,
      Requirement: {
        CheckFunction: 'AND',
        Items: childKeys.map((k) => ({ CheckFunction: 'CheckModelRule', ModelRuleId: k })),
      },
      Dependencies: childKeys.slice(),
    };
  }
  // Presence is a containment statement a dataset (or the data model) makes about an artifact it
  // holds, so only those entity types classify this way. An attribute's "MUST include <X>" sentence
  // is a rule about the attribute itself (e.g. "FOCUS column ... MUST include Sku in the Column ID"),
  // and reading it as presence would point the rule's Reference at an entity it does not describe.
  const include = PRESENCE_ENTITY_TYPES.has(ctx.entityType) && node.text.match(INCLUDE_RE);
  if (include) {
    // Datasets check column presence; the data model includes datasets (generic for now).
    const requirement = ctx.entityType === 'Dataset' ? { CheckFunction: 'ColumnPresent', ColumnName: include[1] } : {};
    return { Function: 'Presence', Reference: include[1], Requirement: requirement, Dependencies: [] };
  }
  // Check-function lookup (covers type/format/nullability leaves, incl. format conformance).
  // The entry is a rule fragment; its Function/Requirement/Dependencies seed the derivation here,
  // and `overlay` reapplies the whole fragment after the rule is assembled so that any other key
  // it defines (Type, Notes, a Condition) lands verbatim.
  const looked = checkFunctionFor(node.text, ctx.artifactName);
  if (looked) {
    const vc = looked.ValidationCriteria || {};
    return {
      Function: looked.Function,
      Reference: looked.Reference || ctx.artifactName,
      Requirement: vc.Requirement || {},
      Dependencies: (vc.Dependencies || []).slice(),
      overlay: looked,
    };
  }
  // Attribute conformance: a dependency only when X is a real (generated) attribute.
  const conform = node.text.match(CONFORM_RE);
  if (conform && ctx.attrRoots && ctx.attrRoots[conform[1]]) {
    return { Function: functionForSentence(node.text), Reference: ctx.artifactName, Requirement: {}, Dependencies: [ctx.attrRoots[conform[1]]] };
  }
  // Unclassified leaf: no check function found — empty Requirement, flagged for a warning.
  return { Function: functionForSentence(node.text), Reference: ctx.artifactName, Requirement: {}, Dependencies: [], unclassified: true };
}

/** Construct a single model rule object from a requirement-tree node. */
function makeRule(node, order, childKeys, ctx, modelVersionIntroduced, status, prevRule) {
  const c = classify(node, childKeys, ctx);
  const keyword = node.text.match(BCP14_KEYWORD);

  // Adopt the baseline rule's curation when the current derivation produced no Requirement
  // (the current lookup wins whenever it does resolve one). `prevRule` is set only for a
  // reused id, i.e. this sentence matched an Active baseline rule's MustSatisfy exactly, so
  // that rule's curation is what the model already says about this exact requirement.
  //
  // Two cases, both adopted the same way:
  //   * Baseline Requirement populated - enum value lists and functions like
  //     CheckNationalCurrency live only in the model and cannot be re-derived from the
  //     sentence text, so regenerating from the lookup alone would drop them.
  //   * Baseline Requirement empty - the rule is already curated as intentionally Dynamic
  //     (no check function is expected), so it is accepted rather than reported as unmapped.
  //
  // Adoption is optimistic. A carried Requirement / Dependencies may reference other rules
  // (CheckModelRule / Dependencies) whose NumericId shifted between versions, so the global
  // post-pass in main() reverts any carry whose references do not resolve. Everything that
  // resolves is kept, recovering curation the lookup cannot derive.
  const prevVc = (prevRule && prevRule.ValidationCriteria) || null;
  const prevReq = (prevVc && prevVc.Requirement) || {};
  const adoptCurated = Object.keys(prevReq).length
    // Any branch that derived no Requirement yields to a curated one.
    ? !Object.keys(c.Requirement).length
    // An empty baseline Requirement only settles a leaf that derived nothing at all; the
    // Presence and attribute-conformance branches keep their own derived Dependencies.
    : Boolean(prevVc) && Boolean(c.unclassified);
  if (adoptCurated) {
    c.accepted = !Object.keys(prevReq).length;
    c.unclassified = false;
    c.carried = true;
    c.Function = prevRule.Function;
    c.Reference = prevRule.Reference;
    c.Requirement = JSON.parse(JSON.stringify(prevReq));
    c.Dependencies = (prevVc.Dependencies || []).slice();
    c.carriedCondition = prevVc.Condition && Object.keys(prevVc.Condition).length
      ? JSON.parse(JSON.stringify(prevVc.Condition)) : null;
  }

  // A Condition is carried on its own, not only alongside a carried Requirement.
  //
  // The Condition records the machine-checkable form of the sentence's "When ..." clause, and
  // nothing in this extractor derives one. A composite always derives its own Requirement (an AND
  // over its children), so the adoption above never fires for it and its Condition would be lost,
  // even though the sentence it was written for is unchanged. A reused id means an exact
  // MustSatisfy match, so the clause the Condition encodes is still the clause in the markdown.
  if (!c.carriedCondition && prevVc && prevVc.Condition && Object.keys(prevVc.Condition).length) {
    c.carriedCondition = JSON.parse(JSON.stringify(prevVc.Condition));
    c.conditionOnlyCarry = true;
  }
  // A composite's operator is carried from the matched baseline rule.
  //
  // Nested bullets say that a requirement has parts; they never say whether the parts hold
  // together or as alternatives, and the markdown for an OR composite is indistinguishable from an
  // AND one (SubAccountType and SubAccountName state the same two nullability bullets, and the
  // model reads the first as OR and the second as AND). Derivation defaults to AND, so an OR is
  // curation only the model holds, and a reused id means it was recorded against this exact
  // sentence. Carried operators are reported so an editor can confirm each one.
  if (c.Function === 'Composite' && prevRule && prevRule.Function === 'Composite') {
    const prevOperator = prevReq.CheckFunction;
    if (prevOperator && prevOperator !== c.Requirement.CheckFunction) {
      CARRIED_OPERATORS.push({
        entity: `${ctx.entityType} ${ctx.artifactName}`,
        operator: prevOperator,
        text: node.text,
      });
      c.Requirement.CheckFunction = prevOperator;
    }
  }

  const entityName = c.Reference === ctx.artifactName
    ? ctx.displayName
    : DISPLAY_NAMES[c.Reference] || pascalToDisplay(c.Reference);

  if (c.unclassified) {
    WARNINGS.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text });
  } else if (c.accepted) {
    ACCEPTED_DYNAMIC.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text });
  }

  // A populated Requirement (a check-function template) is Static; an empty one is Dynamic.
  const type = Object.keys(c.Requirement).length > 0 ? 'Static' : 'Dynamic';

  // Conditions come from `#operatingmodelconditions.<anchor>` links in the sentence. A matched
  // baseline rule can carry conditions its sentence does not link, so the baseline list is
  // adopted when the sentence yields none; a derived list always wins, matching how a curated Requirement is handled. The
  // legacy ApplicabilityCriteria key is read too, so an older BASELINE_DIR still resolves.
  // A Condition entity is the thing being evaluated, so a condition link in its own
  // sentence is an operand, not a gate: "IncludesListUnitPrices MUST evaluate to true when
  // IncludesUnitPricing is true" would otherwise record IncludesUnitPricing as gating the rule,
  // making it inapplicable in the very case its sibling rule says evaluates to false.
  const anchors = ctx.entityType === 'Condition' ? [] : (node.conditionAnchors || []);
  const derivedConditions = anchors.map((a) => CONDITIONS[a] || a);
  const prevConditions = prevRule && (prevRule.Conditions || prevRule.ApplicabilityCriteria);
  const conditions = derivedConditions.length || !Array.isArray(prevConditions)
    ? derivedConditions
    : prevConditions.slice();
  // A carried id that no longer names a condition in the spec would be a dangling reference.
  for (const id of conditions) {
    if (!CONDITION_IDS.has(id)) UNKNOWN_CONDITIONS.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, conditionId: id, text: node.text });
  }

  const rule = {
    Function: c.Function,
    Reference: c.Reference,
    EntityType: ctx.entityType,
    EntityName: entityName,
    EntityId: c.Reference,
    // Notes are hand-written commentary that no sentence can express, so they are carried from the
    // matched baseline rule. `prevRule` is set only for a reused id (an exact MustSatisfy match),
    // so a note only follows the requirement it was written about. A null baseline note (the
    // schema permits it, though ~97% of rules use "") normalizes to the empty string.
    Notes: (prevRule && prevRule.Notes) || '',
    ModelVersionIntroduced: modelVersionIntroduced,
    Status: status || 'Active',
    Conditions: conditions,
    Type: type,
    Order: order,
  };
  // Model 1.5 onwards, every rule carries all three fields. DatasetType is the dataset's type
  // code for dataset-scoped entities and the entity's own ID prefix otherwise (ATT for
  // attributes, DMO for the data model, matching the CON prefix the conditions rules use).
  // DatasetId and DatasetName are null unless the rule really belongs to a dataset.
  rule.DatasetType = ctx.datasetType || ctx.idPrefix || null;
  rule.DatasetId = ctx.datasetId || null;
  rule.DatasetName = ctx.datasetName || null;
  rule.ValidationCriteria = {
    MustSatisfy: node.text,
    Keyword: keyword ? keyword[1] : '',
    Requirement: c.Requirement,
    Condition: c.carriedCondition || {},
    Dependencies: c.Dependencies,
  };
  // Apply the lookup fragment verbatim. Everything above derived a rule from the sentence; a
  // mapping is the editor's statement about that sentence, so any key it defines wins. Placed
  // after assembly so an entry can set a top-level field (Type, Notes) as readily as a nested
  // one, and before the Dependencies invariant so anything it introduces is still reconciled.
  // Curation carried from a matched baseline rule stays ahead of it: that is a decision recorded
  // against this exact sentence in the published model, which a generic pattern should not undo.
  if (c.overlay && !c.carried) Object.assign(rule, deepMerge(rule, c.overlay));

  // Invariant: a rule that evaluates another rule through CheckModelRule depends on it, so every
  // ModelRuleId named by the Requirement or the Condition must appear in Dependencies. Existing
  // entries keep their order and only missing refs are appended: Dependencies may legitimately
  // hold non-CheckModelRule entries (an attribute root from "MUST conform to <Attr>"), and the
  // baseline does not always list the refs first, so rewriting the order would churn rules that
  // already match.
  const deps = rule.ValidationCriteria.Dependencies;
  for (const ref of modelRuleRefs(c.Requirement).concat(modelRuleRefs(rule.ValidationCriteria.Condition))) {
    if (!deps.includes(ref)) deps.push(ref);
  }
  // Dependencies on OTHER entities are carried from the matched baseline rule.
  //
  // A requirement that names another column ("When ListUnitPrice is null, ListCost MUST...") depends
  // on that column, but which of its rules is the right target is a curated decision the sentence
  // does not state: sometimes the column's root, sometimes the one rule about it that matters here.
  // Only the model holds that answer, and a reused id means it was recorded against this exact
  // sentence. Same-entity dependencies are not carried; those are this rule's own children, and the
  // derivation above has already produced them with current ids. Ids that no longer resolve to a
  // live rule are dropped by the post-pass.
  if (prevVc) {
    for (const dep of prevVc.Dependencies || []) {
      if (entityOfRuleId(dep) === ctx.artifactName || deps.includes(dep)) continue;
      deps.push(dep);
      (rule.__carriedDeps = rule.__carriedDeps || []).push(dep);
    }
  }
  // Transient marker (stripped before write) so the post-pass can validate carried refs
  // and re-warn if it must revert one.
  if (c.carried) rule.__carried = { entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text };
  // A Condition carried on its own is validated separately: the rule's derived Requirement stands
  // either way, so an unresolvable reference drops the Condition rather than reverting the rule.
  if (c.conditionOnlyCarry) {
    rule.__carriedCondition = { entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text };
    CARRIED_CONDITIONS.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text });
  }
  return rule;
}

// ---------------------------------------------------------------------------
// Baselines + stable-ID expansion
// ---------------------------------------------------------------------------

/** Merge all rule JSON files directly inside a baseline model_rules subdirectory. */
function loadBaselineDir(...relParts) {
  const dir = path.join(BASELINE_ROOT, 'model_rules', ...relParts);
  if (!fs.existsSync(dir)) return null;
  const rules = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) Object.assign(rules, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return Object.keys(rules).length ? rules : null;
}

/**
 * Accept the pre-1.6 lookup shape, `{ function, requirement }`, alongside the rule-shaped one.
 *
 * The published 1.5 release carries the flat form, and a baseline lookup merges over the
 * extractor's, so both shapes have to land in the same structure before they can be merged at all.
 * Converted entries are counted so the release copy can be migrated.
 */
function normalizeLookup(lookup) {
  const out = {};
  for (const [key, entry] of Object.entries(lookup)) {
    if (entry && entry.requirement !== undefined && entry.ValidationCriteria === undefined) {
      LEGACY_LOOKUP_ENTRIES.push(key);
      out[key] = { Function: entry.function, ValidationCriteria: { Requirement: entry.requirement } };
    } else {
      out[key] = entry;
    }
  }
  return out;
}

/** Load a single baseline rule JSON file. */
function loadBaselineFile(...relParts) {
  const file = path.join(BASELINE_ROOT, 'model_rules', ...relParts);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Baseline file holding the rules for an output path. The output tree mirrors
 * releases/<v>/model_rules/, so the relative path maps across directly. Returned relative to
 * requirements_model/ for display.
 */
function baselineFileFor(outPath) {
  return path.join(BASELINE_LABEL, 'model_rules', path.relative(OUTPUT_ROOT, outPath));
}

/** ModelVersion recorded in the baseline's model_details.json; falls back to the directory name. */
function baselineModelVersion() {
  const file = path.join(BASELINE_ROOT, 'model_details.json');
  if (!fs.existsSync(file)) return path.basename(BASELINE_ROOT);
  const details = JSON.parse(fs.readFileSync(file, 'utf8')).Details || {};
  return details.ModelVersion || path.basename(BASELINE_ROOT);
}

/**
 * The check-function lookup (sentence -> { function, requirement }).
 *
 * Owned by the extractor, not by a release: the entries are generic sentence templates
 * ("{entity} MUST be of type String.") describing how the extractor reads English, and in
 * practice the file was only ever written once, into 1.5. A baseline may still carry its own
 * copy, which merges over the tool's so a release can correct or extend a pattern without a
 * tool change.
 */
function loadCheckLookup() {
  const base = normalizeLookup(fs.existsSync(CHECK_LOOKUP_PATH) ? JSON.parse(fs.readFileSync(CHECK_LOOKUP_PATH, 'utf8')) : {});
  const file = path.join(BASELINE_ROOT, 'check_function_lookup.json');
  if (!fs.existsSync(file)) return base;
  const release = normalizeLookup(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const key of Object.keys(release)) {
    if (key in base && JSON.stringify(base[key]) !== JSON.stringify(release[key])) {
      LOOKUP_OVERRIDES.push(key);
    }
  }
  return { ...base, ...release };
}

/**
 * Check-function names this run emitted that the baseline's catalog does not define.
 *
 * The lookup travels with the extractor but its targets are release data: a CheckFunction only
 * means something if the release being extracted against declares it. A name with no entry
 * produces a Requirement no validator can run, and nothing downstream notices.
 *
 * Only mappings this run actually matched are reported. The lookup is a superset covering every
 * dataset, so an entry the markdown never triggers says nothing about the target release, and
 * flagging it would bury the real signal.
 */
function unknownCheckFunctions() {
  const file = path.join(BASELINE_ROOT, 'check_functions.json');
  if (!fs.existsSync(file)) return [];
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8')).CheckFunctions || {};
  const unknown = [];
  for (const sentence of USED_LOOKUP_KEYS) {
    const vc = (CHECK_LOOKUP[sentence] || {}).ValidationCriteria || {};
    const fn = (vc.Requirement || {}).CheckFunction;
    if (fn && !(fn in catalog)) unknown.push({ sentence, fn });
  }
  return unknown;
}

/**
 * Collect EntityId -> Display Name for every entity the contract locates, before any entity is
 * expanded. A dataset is emitted before its columns, yet its presence rules name those columns,
 * so the map has to be complete up front rather than filled in as entities are processed.
 * Files without both headings (overview pages) are skipped, matching the emit loops.
 */
function collectDisplayNames(contract) {
  const names = {};
  const record = (tokens, headings, depth = 2) => {
    if (!hasSection(tokens, headings.Id, depth) || !hasSection(tokens, headings.DisplayName, depth)) return;
    names[getSectionText(tokens, headings.Id, depth)] = getSectionText(tokens, headings.DisplayName, depth);
  };
  const lex = (file) => marked.lexer(fs.readFileSync(file, 'utf8'));

  for (const section of [contract.Attributes, contract.Conditions]) {
    const dir = specPath(SPEC_ROOT, section.Location);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      record(lex(path.join(dir, file)), section.Headings);
    }
  }

  const dm = contract.DataModel;
  record(lex(specPath(SPEC_ROOT, dm.Location)), dm.Headings);

  const dsLocation = specPath(SPEC_ROOT, contract.Datasets.Location);
  for (const folder of resolveDatasetFolders(dsLocation)) {
    record(lex(path.join(dsLocation, folder, 'dataset.md')), contract.Datasets.Headings);
    const colDir = path.join(dsLocation, folder, 'columns');
    if (!fs.existsSync(colDir)) continue;
    for (const file of fs.readdirSync(colDir).filter((f) => f.endsWith('.md'))) {
      const tokens = lex(path.join(colDir, file));
      record(tokens, contract.Columns.Headings);
      if (contract.Objects) record(tokens, contract.Objects.Headings, contract.Objects.HeadingDepth);
    }
  }
  return names;
}

/**
 * The markdown files of an entity folder, with the folder that was resolved.
 *
 * A missing folder is a hard failure rather than an empty list: the extractor would otherwise
 * generate nothing for that entity kind, and every baseline rule it owns would read as removed.
 * The message names every spelling the contract allows, so a folder renamed in the spec is
 * obvious from the log.
 */
function entityFiles(section, label) {
  const dir = specPath(SPEC_ROOT, section.Location);
  if (!fs.existsSync(dir)) {
    const tried = (Array.isArray(section.Location) ? section.Location : [section.Location]).join(', ');
    throw new UsageError(`${label} folder not found: ${dir}\nThe contract expects one of: ${tried}`);
  }
  return { dir, files: fs.readdirSync(dir).filter((f) => f.endsWith('.md')) };
}

/**
 * Fail when a folder full of markdown yielded no entity at all.
 *
 * Files without the entity sections are skipped by design (overview pages), so a renamed Id
 * heading would otherwise look exactly like a folder of overviews: extraction would succeed and
 * quietly tombstone the whole entity kind.
 */
function requireEntities(count, label, dir, idHeading) {
  if (count) return;
  throw new UsageError(
    `No ${label} entities found in ${dir}\n` +
    `No file there has an H2 "${headingLabel(idHeading)}" section together with a Requirements section.`);
}

/**
 * Map a condition anchor to its Condition ID by scanning the conditions dir.
 *
 * Anchors are the entity's display name lowercased with spaces removed and punctuation kept
 * (e.g. "Includes Pricing-Billing Currency Differences" -> `includespricing-billingcurrencydifferences`),
 * while the Condition ID drops that punctuation and any joining words. The two coincide for
 * most conditions, so both spellings are keyed: the display name resolves the anchors the
 * markdown actually writes, the id keeps ids used directly as anchors resolving.
 */
function loadConditions(locationAbs, headings) {
  const map = {};
  if (!fs.existsSync(locationAbs)) return map;
  for (const file of fs.readdirSync(locationAbs).filter((f) => f.endsWith('.md'))) {
    const tokens = marked.lexer(fs.readFileSync(path.join(locationAbs, file), 'utf8'));
    if (!hasSection(tokens, headings.Id)) continue;
    const id = getSectionText(tokens, headings.Id);
    map[id.toLowerCase()] = id;
    if (headings.DisplayName && hasSection(tokens, headings.DisplayName)) {
      map[getSectionText(tokens, headings.DisplayName).toLowerCase().replace(/ /g, '')] = id;
    }
  }
  return map;
}

/** The column whose presence a dataset rule asserts, or null. */
function assertedColumn(rule) {
  const req = rule.ValidationCriteria.Requirement || {};
  if (req.CheckFunction === 'ColumnPresent' && req.ColumnName) return req.ColumnName;
  // A Presence rule left Dynamic (empty Requirement) still names its column in the sentence.
  if (rule.Function === 'Presence') {
    const m = (rule.ValidationCriteria.MustSatisfy || '').match(INCLUDE_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Map each column to the dataset rule that governs its presence: the topmost dataset rule whose
 * subtree asserts presence for that column and nothing else. For most columns that is the single
 * "MUST include <Column>" leaf. For a column with several conditional presence rules it is the
 * composite grouping them (e.g. PricingCurrencyContractedUnitPrice resolves to the
 * "...MUST adhere to the following PricingCurrencyContractedUnitPrice presence requirements:"
 * composite, not to any one of its three MUST/SHOULD/MAY leaves).
 *
 * Ambiguous columns are omitted rather than guessed at.
 */
function presenceRulesByColumn(dsRules) {
  const columns = new Map(); // ruleId -> columns asserted anywhere in its subtree
  const reaches = new Map(); // ruleId -> rule ids in its subtree
  const visit = (id) => {
    if (columns.has(id)) return;
    columns.set(id, new Set());
    reaches.set(id, new Set());
    const rule = dsRules[id];
    if (!rule || rule.Status === 'Removed') return;
    const cols = columns.get(id);
    const reach = reaches.get(id);
    const col = assertedColumn(rule);
    if (col) cols.add(col);
    for (const ref of modelRuleRefs(rule.ValidationCriteria.Requirement || {})) {
      visit(ref);
      reach.add(ref);
      for (const c of columns.get(ref)) cols.add(c);
      for (const r of reaches.get(ref)) reach.add(r);
    }
  };
  for (const id of Object.keys(dsRules)) visit(id);

  const candidates = {};
  for (const [id, cols] of columns) {
    if (cols.size !== 1) continue; // asserts nothing, or spans several columns
    const col = [...cols][0];
    (candidates[col] = candidates[col] || []).push(id);
  }
  const byColumn = {};
  for (const col of Object.keys(candidates)) {
    // Candidates for one column form an ancestor chain; the topmost is the one no other reaches.
    const top = candidates[col].filter((a) => !candidates[col].some((b) => b !== a && reaches.get(b).has(a)));
    if (top.length === 1) byColumn[col] = top[0];
  }
  return byColumn;
}

/**
 * Order values for a requirement tree, one per spec in markdown (pre-order) sequence.
 *
 * Order records where a rule sits in the markdown, so it has to increase strictly down the
 * document. NumericIds cannot supply it: they are historical and reused, so a rule that moved
 * keeps its old number. The assignment is therefore:
 *
 *   * A rule found in the baseline keeps the Order the baseline gave it, as long as that value
 *     still sits above the previous rule's. This keeps established rules stable.
 *   * A baseline Order at or below the previous rule's is out of sequence, so it is discarded and
 *     the rule renumbered (recorded in ORDER_CONFLICTS, since the baseline disagrees with the
 *     markdown about position).
 *   * A rule needing a fresh value takes the next multiple of ten above the previous rule.
 *   * Unless the following rule already holds a baseline Order that the next multiple of ten
 *     would collide with or overshoot. Then it takes the midpoint of the surrounding pair, so
 *     inserting a rule never forces the rules after it out of sequence.
 *
 * A negative baseline Order (the -1 on a tombstone) never counts as a usable value.
 */
function assignOrders(idByIdx, prevRules, ctx) {
  const baselineOrder = (idx) => {
    const prev = idx < idByIdx.length && prevRules ? prevRules[idByIdx[idx]] : null;
    return prev && typeof prev.Order === 'number' && prev.Order >= 0 ? prev.Order : null;
  };

  const orders = [];
  let prev = -1; // so the first rule lands on 0
  for (let i = 0; i < idByIdx.length; i++) {
    const own = baselineOrder(i);
    if (own !== null && own > prev) {
      orders.push(own);
      prev = own;
      continue;
    }
    if (own !== null) {
      ORDER_CONFLICTS.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, ruleId: idByIdx[i], baseline: own, after: prev });
    }
    const rounded = Math.floor(prev / 10) * 10 + 10;
    const next = baselineOrder(i + 1);
    let assigned = rounded;
    if (next !== null && next > prev && rounded >= next) {
      const mid = Math.floor((prev + next) / 2);
      // With no integer between the pair there is no room; fall back to the rounded value and
      // let the following rule be renumbered rather than emit a duplicate Order.
      if (mid > prev) assigned = mid;
    }
    orders.push(assigned);
    prev = assigned;
  }
  return orders;
}

/** Expand a requirement tree into { RuleId: rule }, reusing stable IDs and tombstoning removals. */
function expandTree(root, ctx, prevRules, outPath) {
  const specs = flattenTree(root);

  // Live previous rules are eligible for ID reuse: an exact MustSatisfy match means the
  // requirement is already in the model. Deprecated counts as live, because a deprecated entity
  // keeps its requirements in the spec and only its Status changes; reusing the id is what keeps
  // that lifecycle attached to the rule. A match against a Removed rule does NOT count; that text
  // gets a new NumericId. All previous IDs still advance maxNumericId so tombstoned numbers are
  // never reassigned.
  const prevByText = new Map();
  const reserved = ctx.reservedIds || new Set();
  let maxNumericId = -1;
  if (prevRules) {
    for (const id of Object.keys(prevRules)) {
      maxNumericId = Math.max(maxNumericId, numericIdOf(id));
      if (reserved.has(id)) continue;
      if (prevRules[id].Status !== 'Removed') {
        prevByText.set(normalizeMustSatisfy(prevRules[id].ValidationCriteria.MustSatisfy), id);
      }
    }
  }

  const reusedIds = new Set();
  let nextNumericId = maxNumericId + 1;
  const idByIdx = specs.map((spec) => {
    const prevId = prevByText.get(normalizeMustSatisfy(spec.text));
    if (prevId) {
      reusedIds.add(prevId);
      return prevId;
    }
    const keyword = spec.text.match(BCP14_KEYWORD);
    const status = statusLetter(keyword && keyword[1], CONDITIONAL_RE.test(spec.text));
    return buildRuleId(ctx, nextNumericId++, status);
  });

  const orders = assignOrders(idByIdx, prevRules, ctx);

  const output = {};
  specs.forEach((spec, idx) => {
    const id = idByIdx[idx];
    const childKeys = spec.childIdx.map((ci) => idByIdx[ci]);
    // Status comes from the entity as the markdown presents it today, not from the baseline: an
    // entity marked deprecated emits deprecated rules, and one whose marker was removed emits
    // active ones again. Only the introduced version carries over.
    const prev = prevRules && prevRules[id];
    const introduced = prev ? prev.ModelVersionIntroduced : NEW_VERSION;
    output[id] = makeRule(spec.node, orders[idx], childKeys, ctx, introduced, ctx.entityStatus || 'Active', prev);
  });

  // A column's requirements only bind when the dataset includes the column, so the column's root
  // composite depends on the dataset rule governing that column's presence.
  //
  // That presence rule carries the column as its EntityId, so it joins the root's own children as a
  // same-entity dependency, and those are read in Order sequence. It is therefore placed by its
  // Order rather than appended: a presence rule that sits early in the dataset would otherwise
  // trail children that come after it.
  const presenceId = ctx.presenceByColumn && ctx.presenceByColumn[ctx.artifactName];
  if (presenceId && specs.length) {
    const deps = output[idByIdx[0]].ValidationCriteria.Dependencies;
    // The baseline lists this dependency too, and it was carried in as a cross-entity dependency
    // before the current presence rule was resolved. Drop that copy so the placement below decides
    // where it goes.
    const existing = deps.indexOf(presenceId);
    if (existing !== -1) deps.splice(existing, 1);
    const presenceRule = ctx.datasetRules && ctx.datasetRules[presenceId];
    const presenceOrder = presenceRule && typeof presenceRule.Order === 'number' ? presenceRule.Order : Infinity;
    const at = deps.findIndex((d) => output[d] && output[d].Order > presenceOrder);
    if (at === -1) deps.push(presenceId);
    else deps.splice(at, 0, presenceId);
  }

  if (prevRules) {
    for (const id of Object.keys(prevRules)) {
      if (reusedIds.has(id) || reserved.has(id)) continue;
      const carried = renameConditions(JSON.parse(JSON.stringify(prevRules[id])));
      // A baseline rule introduced in the version being drafted was never published, so a
      // tombstone would announce the removal of something no consumer ever saw: drop it from
      // the output instead. The baseline still holds a copy that this run cannot edit, so
      // record it for the report - that copy has to be deleted by hand.
      if (carried.ModelVersionIntroduced === NEW_VERSION) {
        UNPUBLISHED_REMOVALS.push({
          entity: `${ctx.entityType} ${ctx.artifactName}`,
          ruleId: id,
          file: baselineFileFor(outPath),
          text: (carried.ValidationCriteria || {}).MustSatisfy || '',
        });
        continue;
      }
      if (!carried.ModelVersionRemoved) {
        carried.Status = 'Removed';
        carried.ModelVersionRemoved = NEW_VERSION;
        carried.Order = -1; // removed rules are never referenced as a requirement
      }
      output[id] = carried;
    }
  }

  const sorted = {};
  for (const id of Object.keys(output).sort((a, b) => numericIdOf(a) - numericIdOf(b))) sorted[id] = output[id];
  return sorted;
}

/**
 * The baseline's columns-composite rule for a dataset: the one Composite whose dependencies are
 * all column root rules. It gathers every column of the dataset under the dataset's root, and no
 * markdown sentence produces it, so it is identified structurally rather than by its text (which
 * in CostAndUsage is a verbatim copy of the root rule's sentence).
 */
function columnsCompositeId(prevRules) {
  if (!prevRules) return null;
  const ids = Object.keys(prevRules).filter((id) => {
    const rule = prevRules[id];
    if (rule.Function !== 'Composite' || rule.Status === 'Removed') return false;
    const deps = (rule.ValidationCriteria || {}).Dependencies || [];
    return deps.length > 0 && deps.every((d) => C000_RE.test(d));
  });
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Build (or rebuild) the dataset's columns-composite rule over the current column roots and hang
 * it off the dataset's root rule.
 *
 * The rule is regenerated from the columns that actually exist, so a column added to or dropped
 * from the spec is picked up. Baseline dependency order is preserved for the columns still
 * present, with new ones appended, so a run that changes nothing rewrites nothing. Order is -1:
 * the rule holds no position in the markdown.
 */
function addColumnsComposite(dsRules, columnRootIds, ctx, prevRules, reservedId) {
  if (!columnRootIds.length) return;
  const prev = reservedId && prevRules ? prevRules[reservedId] : null;
  let ruleId = reservedId;
  if (!ruleId) {
    const nextId = Math.max(-1, ...Object.keys(dsRules).map(numericIdOf)) + 1;
    ruleId = buildRuleId(ctx, nextId, 'M');
  }

  // Baseline order first (for the columns that survive), then whatever is new.
  const prevDeps = prev ? (prev.ValidationCriteria.Dependencies || []) : [];
  const live = new Set(columnRootIds);
  const deps = prevDeps.filter((d) => live.has(d));
  for (const id of columnRootIds) if (!deps.includes(id)) deps.push(id);

  dsRules[ruleId] = {
    Function: 'Composite',
    Reference: ctx.artifactName,
    EntityType: ctx.entityType,
    EntityName: ctx.displayName,
    EntityId: ctx.artifactName,
    Notes: (prev && prev.Notes) || 'Columns composite rule',
    ModelVersionIntroduced: prev ? prev.ModelVersionIntroduced : NEW_VERSION,
    Status: 'Active',
    Conditions: [],
    Type: 'Static',
    Order: -1,
    DatasetType: ctx.datasetType,
    DatasetId: ctx.datasetId,
    DatasetName: ctx.datasetName,
    ValidationCriteria: {
      MustSatisfy: prev
        ? prev.ValidationCriteria.MustSatisfy
        : `The ${ctx.artifactName} dataset adheres to the following additional requirements:`,
      Keyword: 'MUST',
      Requirement: {
        CheckFunction: 'AND',
        Items: deps.map((k) => ({ CheckFunction: 'CheckModelRule', ModelRuleId: k })),
      },
      Condition: {},
      Dependencies: deps,
    },
  };

  // The dataset root evaluates every column through this rule, so it depends on it. Appended last,
  // after the requirements the markdown states directly.
  const rootId = rootRuleId(dsRules);
  if (rootId && rootId !== ruleId) {
    const rootVc = dsRules[rootId].ValidationCriteria;
    if (!rootVc.Dependencies.includes(ruleId)) rootVc.Dependencies.push(ruleId);
    const items = (rootVc.Requirement || {}).Items;
    if (Array.isArray(items) && !modelRuleRefs(rootVc.Requirement).includes(ruleId)) {
      items.push({ CheckFunction: 'CheckModelRule', ModelRuleId: ruleId });
    }
  }

  const sorted = {};
  for (const id of Object.keys(dsRules).sort((a, b) => numericIdOf(a) - numericIdOf(b))) sorted[id] = dsRules[id];
  for (const id of Object.keys(dsRules)) delete dsRules[id];
  Object.assign(dsRules, sorted);
}

/**
 * Point a presence-grouping composite at the column it governs.
 *
 * A column with several conditional presence rules ("MUST include X when..., SHOULD include X
 * when..., MAY include X otherwise") has them grouped under one dataset composite, and that
 * composite is what the column's root depends on. classify() gives every composite the enclosing
 * entity as its Reference, which for these rules names the dataset rather than the column being
 * required, and leaves the conditions empty even though the column only applies under its own.
 * Both are corrected here, once the column roots exist to read them from.
 */
function alignPresenceComposites(dsRules, columnRootsById, presenceByColumn) {
  for (const colId of Object.keys(presenceByColumn)) {
    const root = columnRootsById[colId];
    const groupRule = dsRules[presenceByColumn[colId]];
    if (!root || !groupRule || groupRule.Function !== 'Composite') continue;
    groupRule.Reference = colId;
    groupRule.EntityId = colId;
    groupRule.EntityName = DISPLAY_NAMES[colId] || pascalToDisplay(colId);
    groupRule.Conditions = (root.Conditions || []).slice();
  }
}

/**
 * Deprecate the dataset rules that are about a deprecated column.
 *
 * A column's deprecation is stated in the column's own markdown, but the obligation to include it
 * lives in the dataset ("CostAndUsage MUST include ProviderName"). Leaving that rule Active would
 * say the dataset still has to carry a column the spec has deprecated, so every dataset rule whose
 * subject is a deprecated column follows it. The dataset's own root and its columns composite stay
 * Active: a deprecated column is still part of the dataset until it is removed outright.
 */
function deprecateColumnRules(dsRules, deprecatedColumns) {
  if (!deprecatedColumns.size) return;
  for (const id of Object.keys(dsRules)) {
    const rule = dsRules[id];
    if (rule.Status !== 'Active' || !deprecatedColumns.has(rule.EntityId)) continue;
    rule.Status = 'Deprecated';
  }
}

// ---------------------------------------------------------------------------
// Per-entity emit + main
// ---------------------------------------------------------------------------

// 2-space indent and a trailing newline match the hand-authored baseline files, so a fully
// derived entity is byte-identical to its baseline copy and `npm run diff` reads clean.
function writeJson(outPath, obj) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Parse one markdown file and expand it against its baseline. Output is collected in
 * EMITTED (not written yet) so the global carry-forward post-pass can run with every
 * rule ID visible before anything is persisted.
 *
 * `depth` is the heading level of the entity's sections. It is 2 for a file that defines one
 * entity, and 3 for an entity nested inside another's file (an object inside its column).
 */
function emit(mdPath, ctx, headings, baseline, outPath, depth = 2) {
  const tokens = marked.lexer(fs.readFileSync(mdPath, 'utf8'));
  if (isDeprecatedEntity(tokens, headings, depth)) {
    ctx.entityStatus = 'Deprecated';
    DEPRECATED_ENTITIES.push(`${ctx.entityType} ${ctx.artifactName}`);
  }
  const tree = parseRequirementTree(tokens, headings.Requirements, depth);
  const rules = expandTree(tree, ctx, baseline, outPath);
  EMITTED.push({ outPath, rules });
  return rules;
}

/**
 * RuleIds a rule points at (for cross-version ref validation). Covers the Condition as well as
 * the Requirement: a carried Condition can name a rule whose NumericId shifted between versions,
 * and that carry has to be reverted just like an unresolvable Requirement ref.
 */
function referencedIds(rule) {
  const vc = rule.ValidationCriteria;
  return modelRuleRefs(vc.Requirement).concat(modelRuleRefs(vc.Condition), vc.Dependencies || []);
}

/**
 * Validate every carried-forward Requirement against the full set of generated rule IDs.
 * A carry whose references don't all resolve (e.g. a baseline dependency whose NumericId
 * shifted) is reverted to an empty, Dynamic rule and re-flagged as unmapped. Then strip
 * the transient marker and persist every file.
 */
/**
 * Correct the status letter of rules introduced in this run.
 *
 * A published rule id is permanent, so only rules this run introduces can be relettered; an
 * inherited letter stays as the model recorded it. Every reference to a renamed rule is rewritten
 * with it, across all files, so the rename is invisible to everything but the id itself.
 */
function relabelNewRuleStatuses() {
  const allRules = {};
  for (const { rules } of EMITTED) Object.assign(allRules, rules);

  const renames = new Map();
  for (const id of Object.keys(allRules)) {
    const rule = allRules[id];
    if (rule.Status !== 'Active' || rule.ModelVersionIntroduced !== NEW_VERSION) continue;
    const expected = statusLetterFor(rule, allRules);
    const current = id.slice(-1);
    if (expected === current) continue;
    const renamed = id.slice(0, -1) + expected;
    if (allRules[renamed]) continue; // never collide with a rule that already holds the id
    renames.set(id, renamed);
  }
  if (!renames.size) return renames;

  const rewrite = (node) => {
    if (Array.isArray(node)) return node.forEach(rewrite);
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (key === 'ModelRuleId' && renames.has(node[key])) node[key] = renames.get(node[key]);
      else rewrite(node[key]);
    }
  };

  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) {
      const vc = rules[id].ValidationCriteria;
      vc.Dependencies = (vc.Dependencies || []).map((d) => renames.get(d) || d);
      rewrite(vc.Requirement);
      rewrite(vc.Condition);
    }
    for (const [from, to] of renames) {
      if (!(from in rules)) continue;
      rules[to] = rules[from];
      delete rules[from];
    }
    const sorted = {};
    for (const id of Object.keys(rules).sort((a, b) => numericIdOf(a) - numericIdOf(b))) sorted[id] = rules[id];
    for (const id of Object.keys(rules)) delete rules[id];
    Object.assign(rules, sorted);
  }
  return renames;
}

function finalizeEmitted() {
  const liveIds = new Set();
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) if (rules[id].Status !== 'Removed') liveIds.add(id);
  }
  // A Condition carried on its own must still resolve. If it names a rule that was renumbered or
  // removed, the Condition is dropped (with its dependencies) and the rule keeps its own
  // derivation, rather than the whole rule being reverted.
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) {
      const r = rules[id];
      const carried = r.__carriedCondition;
      delete r.__carriedCondition;
      if (!carried || r.Status === 'Removed') continue;
      const refs = modelRuleRefs(r.ValidationCriteria.Condition);
      if (refs.every((x) => liveIds.has(x))) continue;
      r.ValidationCriteria.Condition = {};
      r.ValidationCriteria.Dependencies = r.ValidationCriteria.Dependencies.filter((d) => !refs.includes(d));
      WARNINGS.push(carried);
    }
  }
  // A carried cross-entity dependency whose target was renumbered or removed since the baseline
  // would point at nothing, so it is dropped rather than reverting the whole rule.
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) {
      const r = rules[id];
      const carriedDeps = r.__carriedDeps;
      delete r.__carriedDeps;
      if (!carriedDeps) continue;
      r.ValidationCriteria.Dependencies = r.ValidationCriteria.Dependencies.filter(
        (d) => !carriedDeps.includes(d) || liveIds.has(d)
      );
    }
  }
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) {
      const r = rules[id];
      const carried = r.__carried;
      delete r.__carried;
      if (!carried || r.Status === 'Removed') continue;
      if (referencedIds(r).every((x) => liveIds.has(x))) continue;
      r.Function = functionForSentence(r.ValidationCriteria.MustSatisfy || '');
      r.Type = 'Dynamic';
      r.ValidationCriteria.Requirement = {};
      r.ValidationCriteria.Condition = {};
      r.ValidationCriteria.Dependencies = [];
      WARNINGS.push(carried);
    }
  }
  for (const { outPath, rules } of EMITTED) writeJson(outPath, rules);
}

/**
 * Carry forward baseline rule files whose entity no longer exists in the markdown.
 *
 * Rule-level tombstoning only reaches entities the markdown still defines. When a whole entity is
 * deleted (the ColumnHandling attribute folded into FocusColumnHandling, the ProviderName column
 * removed), nothing re-emits its file, so its rules disappear and every rule that still references
 * them dangles. Each such file is re-emitted with all of its rules tombstoned, exactly as
 * expandTree() tombstones an individual rule: already-Removed rules keep the version that removed
 * them, and anything still live is marked Removed in NEW_VERSION.
 */
function carryRemovedEntities() {
  const baselineRoot = path.join(BASELINE_ROOT, 'model_rules');
  if (!fs.existsSync(baselineRoot)) return;
  const emittedPaths = new Set(EMITTED.map((e) => path.resolve(e.outPath)));

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const outPath = path.join(OUTPUT_ROOT, path.relative(baselineRoot, full));
      if (emittedPaths.has(path.resolve(outPath))) continue;

      const rules = renameConditions(JSON.parse(fs.readFileSync(full, 'utf8')));
      for (const id of Object.keys(rules)) {
        const rule = rules[id];
        if (rule.ModelVersionRemoved) continue;
        rule.Status = 'Removed';
        rule.ModelVersionRemoved = NEW_VERSION;
        rule.Order = -1;
      }
      EMITTED.push({ outPath, rules });
      REMOVED_ENTITIES.push({ file: path.relative(baselineRoot, full), count: Object.keys(rules).length });
    }
  };
  walk(baselineRoot);
}

/**
 * Copy the baseline release's non-derivable model files into the output folder.
 *
 * The extractor only derives model_rules/; a model also needs the check-function catalog, the
 * condition and dataset registries, the schema it validates against, and the JSON Schemas rules
 * reference by id. Copying them keeps the output buildable on its own and in step with the
 * baseline. model_details.json is restamped with NEW_VERSION, which is what the rules carry.
 */
function copyReleaseAssets() {
  const copied = [];
  const copyTree = (src, dest) => {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) copyTree(path.join(src, entry), path.join(dest, entry));
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  for (const asset of RELEASE_ASSETS) {
    const src = path.join(BASELINE_ROOT, asset);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(OUTPUT_DIR, asset));
    copied.push(asset);
  }

  const detailsPath = path.join(OUTPUT_DIR, 'model_details.json');
  if (fs.existsSync(detailsPath)) {
    const details = JSON.parse(fs.readFileSync(detailsPath, 'utf8'));
    details.Details = details.Details || {};
    details.Details.ModelVersion = NEW_VERSION;
    fs.writeFileSync(detailsPath, JSON.stringify(details, null, 2) + '\n');
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const FLAGS = ['specification', 'baseline', 'output'];

const USAGE = `Usage: node extract_rm.js [options]

Options:
  --specification <folder>  Specification markdown to extract from: the folder holding
                            datasets/, attributes/ and operating_model_conditions/.
                            Default: ${DEFAULT_SPEC_ROOT}.
  --baseline <folder>       Baseline release folder to diff against and copy the release
                            assets from. Default: releases/${BASELINE_DIR}.
  --output <folder>         Folder to write the generated model into. Default: the
                            extractor's own output/ folder.
  -h, --help                Show this message.

Folders may be relative to the working directory. Environment: BASELINE_DIR (a folder name
under releases/, overridden by --baseline), NEW_VERSION (version stamped on new rules),
DATASET_FOLDERS (limit to given datasets).`;

/** Point the specification, baseline and output roots at the folders the caller asked for. */
function applyCliOptions(opts) {
  if (opts.specification) SPEC_ROOT = path.resolve(opts.specification);
  if (opts.baseline) {
    BASELINE_ROOT = path.resolve(opts.baseline);
    BASELINE_LABEL = opts.baseline;
  }
  if (opts.output) {
    OUTPUT_DIR = path.resolve(opts.output);
    OUTPUT_ROOT = path.join(OUTPUT_DIR, 'model_rules');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2), FLAGS);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  applyCliOptions(opts);

  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const summary = [];

  if (!fs.existsSync(SPEC_ROOT)) {
    throw new UsageError(`Specification not found: ${SPEC_ROOT}\nPass --specification <folder>.`);
  }
  if (!fs.existsSync(path.join(BASELINE_ROOT, 'model_rules'))) {
    throw new UsageError(
      `Baseline not found: ${path.join(BASELINE_ROOT, 'model_rules')}\n` +
      'Pass --baseline <folder>, or set BASELINE_DIR to a folder name under releases/.');
  }
  PREVIOUS_VERSION = baselineModelVersion();
  if (!process.env.NEW_VERSION) NEW_VERSION = PREVIOUS_VERSION;

  CHECK_LOOKUP = loadCheckLookup();
  if (contract.Conditions.AnchorPrefixes) CONDITION_ANCHOR_RE = conditionAnchorRe(contract.Conditions.AnchorPrefixes);
  CONDITIONS = loadConditions(specPath(SPEC_ROOT, contract.Conditions.Location), contract.Conditions.Headings);
  CONDITION_IDS = new Set(Object.values(CONDITIONS));
  DISPLAY_NAMES = collectDisplayNames(contract);

  // --- DataModel ---
  {
    const dm = contract.DataModel;
    const mdPath = specPath(SPEC_ROOT, dm.Location);
    const tokens = marked.lexer(fs.readFileSync(mdPath, 'utf8'));
    const ctx = {
      entityType: dm.EntityType,
      artifactType: dm.ArtifactType,
      idPrefix: dm.IdPrefix,
      artifactName: getSectionText(tokens, dm.Headings.Id),
      displayName: getSectionText(tokens, dm.Headings.DisplayName),
    };
    const rules = emit(mdPath, ctx, dm.Headings, loadBaselineDir('datamodel'), path.join(OUTPUT_ROOT, 'datamodel.json'));
    summary.push([`DataModel (${ctx.artifactName})`, Object.keys(rules).length]);
  }

  // --- Attributes (first: dataset/column "conform to X" rules depend on their root IDs) ---
  const attrRoots = {}; // attribute EntityId -> its root rule ID (e.g. NullHandling -> ATT-NullHandling-A-000-C)
  const att = contract.Attributes;
  const { dir: attrDir, files: attrFiles } = entityFiles(att, 'Attributes');
  let attrCount = 0;
  for (const file of attrFiles) {
    const attrMdPath = path.join(attrDir, file);
    const attrTokens = marked.lexer(fs.readFileSync(attrMdPath, 'utf8'));
    // Skip non-entity files (e.g. attributes_overview.md) that lack the entity sections.
    if (!hasSection(attrTokens, att.Headings.Id) || !hasSection(attrTokens, att.Headings.Requirements)) continue;
    const attrId = getSectionText(attrTokens, att.Headings.Id);
    const attrCtx = { entityType: att.EntityType, artifactType: att.ArtifactType, idPrefix: att.IdPrefix, artifactName: attrId, displayName: getSectionText(attrTokens, att.Headings.DisplayName) };
    const outName = datasetJsonName(path.basename(file, '.md'));
    const attrOut = path.join(OUTPUT_ROOT, 'attributes', outName);
    const attrRules = emit(attrMdPath, attrCtx, att.Headings, loadBaselineFile('attributes', outName), attrOut);
    attrRoots[attrId] = rootRuleId(attrRules);
    summary.push([`Attribute ${attrId}`, Object.keys(attrRules).length]);
    attrCount++;
  }
  requireEntities(attrCount, 'attribute', attrDir, att.Headings.Id);

  // --- Conditions ---
  // The same markdown loadConditions() reads for the anchor -> ConditionId map, expanded into
  // rules. Conditions belong to no dataset, so they carry DatasetType "CON" with a null
  // DatasetId/DatasetName, the same shape attributes use for ATT.
  // The spec folder was renamed to operating_model_conditions/, but the output stays
  // model_rules/conditions/: that path is the published model's, and moving it would read as
  // every condition entity having been deleted and re-added.
  const cond = contract.Conditions;
  const { dir: condDir, files: condFiles } = entityFiles(cond, 'Conditions');
  let condCount = 0;
  for (const file of condFiles) {
    const condMdPath = path.join(condDir, file);
    const condTokens = marked.lexer(fs.readFileSync(condMdPath, 'utf8'));
    // Skip non-entity files (e.g. an overview page) that lack the entity sections.
    if (!hasSection(condTokens, cond.Headings.Id) || !hasSection(condTokens, cond.Headings.Requirements)) continue;
    const condId = getSectionText(condTokens, cond.Headings.Id);
    const condCtx = { entityType: cond.EntityType, artifactType: cond.ArtifactType, idPrefix: cond.IdPrefix, artifactName: condId, displayName: getSectionText(condTokens, cond.Headings.DisplayName) };
    const outName = datasetJsonName(path.basename(file, '.md'));
    const condOut = path.join(OUTPUT_ROOT, 'conditions', outName);
    const condRules = emit(condMdPath, condCtx, cond.Headings, loadBaselineFile('conditions', outName), condOut);
    summary.push([`Condition ${condId}`, Object.keys(condRules).length]);
    condCount++;
  }
  requireEntities(condCount, 'condition', condDir, cond.Headings.Id);

  // --- Datasets + their Columns ---
  const datasetFolders = resolveDatasetFolders(specPath(SPEC_ROOT, contract.Datasets.Location));
  for (const folder of datasetFolders) {
    const ds = contract.Datasets;
    const dsMdPath = path.join(specPath(SPEC_ROOT, ds.Location), folder, 'dataset.md');
    const dsTokens = marked.lexer(fs.readFileSync(dsMdPath, 'utf8'));
    const datasetId = getSectionText(dsTokens, ds.Headings.Id);
    const datasetName = getSectionText(dsTokens, ds.Headings.DisplayName);
    const datasetType = contract.DatasetTypes[datasetId];
    const dsBaseline = loadBaselineDir('datasets', folder);
    // Reserved from text reuse and from tombstoning: the columns composite is rebuilt below, once
    // the column roots are known. Without the reservation CostAndUsage's root sentence, which the
    // baseline repeats verbatim on the columns composite, would reuse the composite's id.
    const columnsCompositeRuleId = columnsCompositeId(dsBaseline);
    const dsCtx = { entityType: ds.EntityType, artifactType: ds.ArtifactType, idPrefix: datasetType, artifactName: datasetId, displayName: datasetName, datasetType, datasetId, datasetName, attrRoots, reservedIds: new Set(columnsCompositeRuleId ? [columnsCompositeRuleId] : []) };
    const dsOut = path.join(OUTPUT_ROOT, 'datasets', folder, datasetJsonName(folder));
    const dsRules = emit(dsMdPath, dsCtx, ds.Headings, dsBaseline, dsOut);
    summary.push([`Dataset ${datasetId}`, Object.keys(dsRules).length]);

    // Derived from the dataset's own rules, so each column root can depend on the rule that
    // requires it. Columns are emitted after their dataset, so those IDs are already settled.
    const presenceByColumn = presenceRulesByColumn(dsRules);

    const cc = contract.Columns;
    const ob = contract.Objects;
    const columnRootIds = []; // root rule of every column, for the dataset's columns composite
    const columnRootsById = {}; // column EntityId -> its root rule, for the presence-composite pass
    const deprecatedColumns = new Set(); // columns the markdown marks deprecated
    const colDir = path.join(specPath(SPEC_ROOT, ds.Location), folder, 'columns');
    for (const file of fs.readdirSync(colDir).filter((f) => f.endsWith('.md'))) {
      const colMdPath = path.join(colDir, file);
      const colTokens = marked.lexer(fs.readFileSync(colMdPath, 'utf8'));
      const colId = getSectionText(colTokens, cc.Headings.Id);
      const base = path.basename(file, '.md');

      // A JSON-object column documents its object in the SAME file, one heading level down
      // (`## <Object> ` > `### Object Requirements`). The object is emitted first so the
      // column's "MUST conform to <Object> requirements" leaf can depend on its root rule,
      // exactly as attribute conformance depends on an attribute root.
      if (ob && hasSection(colTokens, ob.Headings.Id, ob.HeadingDepth)) {
        const objId = getSectionText(colTokens, ob.Headings.Id, ob.HeadingDepth);
        const objCtx = { entityType: ob.EntityType, artifactType: ob.ArtifactType, idPrefix: datasetType, artifactName: objId, displayName: getSectionText(colTokens, ob.Headings.DisplayName, ob.HeadingDepth), datasetType, datasetId, datasetName, attrRoots };
        const objName = `${objId.toLowerCase()}.json`;
        const objOut = path.join(OUTPUT_ROOT, 'datasets', folder, 'objects', objName);
        const objRules = emit(colMdPath, objCtx, ob.Headings, loadBaselineFile('datasets', folder, 'objects', objName), objOut, ob.HeadingDepth);
        // Object roots share the conformance map with attributes: the ids never collide, and
        // classify() resolves "MUST conform to X requirements" against a single lookup.
        attrRoots[objId] = rootRuleId(objRules);
        summary.push([`  Object ${objId}`, Object.keys(objRules).length]);
      }

      const colCtx = { entityType: cc.EntityType, artifactType: cc.ArtifactType, idPrefix: datasetType, artifactName: colId, displayName: getSectionText(colTokens, cc.Headings.DisplayName), datasetType, datasetId, datasetName, attrRoots, presenceByColumn, datasetRules: dsRules };
      const colOut = path.join(OUTPUT_ROOT, 'datasets', folder, 'columns', `${base}.json`);
      const colRules = emit(colMdPath, colCtx, cc.Headings, loadBaselineFile('datasets', folder, 'columns', `${base}.json`), colOut);
      if (colCtx.entityStatus === 'Deprecated') deprecatedColumns.add(colId);
      const colRootId = rootRuleId(colRules);
      columnRootIds.push(colRootId);
      if (colRootId) columnRootsById[colId] = colRules[colRootId];
      summary.push([`  Column ${colId}`, Object.keys(colRules).length]);
    }

    alignPresenceComposites(dsRules, columnRootsById, presenceByColumn);
    deprecateColumnRules(dsRules, deprecatedColumns);
    addColumnsComposite(dsRules, columnRootIds.filter(Boolean), dsCtx, dsBaseline, columnsCompositeRuleId);
  }

  carryRemovedEntities();
  const renames = relabelNewRuleStatuses();
  finalizeEmitted();
  const assets = copyReleaseAssets();

  console.log(`Baseline: ${BASELINE_LABEL} (model version ${PREVIOUS_VERSION})`);
  console.log(`Wrote model rules under ${OUTPUT_ROOT} (new rules stamped ${NEW_VERSION}):`);
  for (const [name, count] of summary) console.log(`  ${name}: ${count} rules`);
  console.log(`Copied from ${BASELINE_LABEL}: ${assets.join(', ')}`);

  if (renames.size) {
    console.log(`\n${renames.size} rule(s) introduced in ${NEW_VERSION} were relettered to match their scope:`);
    for (const [from, to] of renames) console.log(`    ${from} -> ${to}`);
  }

  if (DEPRECATED_ENTITIES.length) {
    console.log(`\n${DEPRECATED_ENTITIES.length} entit(y/ies) marked deprecated in the markdown; their rules are emitted with Status "Deprecated":`);
    for (const e of DEPRECATED_ENTITIES) console.log(`    ${e}`);
  }

  if (CARRIED_CONDITIONS.length) {
    console.log(`\n${CARRIED_CONDITIONS.length} rule(s) kept a baseline Condition the extractor does not derive.`);
  }

  if (CARRIED_OPERATORS.length) {
    console.log(`\n${CARRIED_OPERATORS.length} composite(s) kept a baseline operator that the bullet list does not state:`);
    for (const c of CARRIED_OPERATORS) console.log(`    ${c.operator}  [${c.entity}]  "${c.text}"`);
  }

  if (REMOVED_ENTITIES.length) {
    console.log(`\n${REMOVED_ENTITIES.length} baseline entity file(s) have no markdown left; carried forward as tombstones:`);
    for (const r of REMOVED_ENTITIES) console.log(`    ${r.file} (${r.count} rules)`);
  }

  if (ACCEPTED_DYNAMIC.length) {
    console.log(`\n${ACCEPTED_DYNAMIC.length} requirement sentence(s) accepted as Dynamic (matched a baseline rule already curated with an empty Requirement).`);
  }

  if (UNPUBLISHED_REMOVALS.length) {
    console.warn(`\n⚠ ${UNPUBLISHED_REMOVALS.length} baseline rule(s) introduced in ${NEW_VERSION} are no longer in the markdown`);
    console.warn(`  (dropped from the output, not tombstoned, because ${NEW_VERSION} is unpublished).`);
    console.warn('  This output folder is not the baseline, so delete each one from its baseline file by hand:');
    for (const r of UNPUBLISHED_REMOVALS) {
      console.warn(`    ${r.ruleId}  [${r.entity}]  ${r.file}`);
      if (r.text) console.warn(`      "${r.text}"`);
    }
  }

  const unknownFns = unknownCheckFunctions();
  if (LEGACY_LOOKUP_ENTRIES.length) {
    console.log(`\n${LEGACY_LOOKUP_ENTRIES.length} check-function mapping(s) read in the pre-1.6 { function, requirement } shape`);
    console.log('  (converted on load; rewrite them as { Function, ValidationCriteria: { Requirement } } to silence this).');
  }

  if (LOOKUP_OVERRIDES.length) {
    console.log(`\n${LOOKUP_OVERRIDES.length} check-function mapping(s) overridden by the baseline's own lookup:`);
    for (const k of LOOKUP_OVERRIDES) console.log(`    "${k}"`);
  }

  if (unknownFns.length) {
    console.warn(`\n⚠ ${unknownFns.length} check-function mapping(s) name a function the baseline's check_functions.json does not define`);
    console.warn('  (the rule is emitted, but no validator can run it):');
    for (const u of unknownFns) console.warn(`    ${u.fn}  <- "${u.sentence}"`);
  }

  if (UNKNOWN_CONDITIONS.length) {
    console.warn(`\n⚠ ${UNKNOWN_CONDITIONS.length} condition id(s) on emitted rules are not defined in ${contract.Conditions.Location}`);
    for (const u of UNKNOWN_CONDITIONS) console.warn(`    ${u.conditionId}  [${u.entity}]  "${u.text}"`);
  }

  if (ORDER_CONFLICTS.length) {
    console.warn(`\n⚠ ${ORDER_CONFLICTS.length} rule(s) had a baseline Order out of markdown sequence`);
    console.warn('  (renumbered here; the baseline Order sat at or below the preceding rule\'s):');
    for (const c of ORDER_CONFLICTS) console.warn(`    ${c.ruleId}  [${c.entity}]  baseline Order ${c.baseline} follows ${c.after}`);
  }

  if (WARNINGS.length) {
    console.warn(`\n⚠ ${WARNINGS.length} requirement sentence(s) have no check-function mapping`);
    console.warn('  (Requirement left empty, Type set to Dynamic). Add entries to the lookup to resolve:');
    for (const w of WARNINGS) console.warn(`    [${w.entity}] ${w.text}`);
  }
}

if (require.main === module) runMain(main, USAGE);

module.exports = { isDeprecatedEntity, deprecateColumnRules, statusLetterFor, columnsCompositeId, pascalToDisplay, deepMerge, normalizeLookup, hasSection, getSectionText, conditionAnchorsOf, functionForSentence };
