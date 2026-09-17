# Requirements Model Extraction

This repository packages a Node.js tool that generates Requirements Model JSON
directly from the FOCUS specification markdown. It replaces manual authoring of
`model_rules/` files: the normative bullet list under each entity's
`## Requirements` heading is parsed and expanded into a family of machine-readable
rules, with stable Rule IDs carried forward across releases.

## Use from GitHub Actions

This repo is a composite action, so a consuming repo (the FOCUS specification build) pulls it
in the way it pulls any other action. No registry and no token: the version is a git tag.

```yaml
- uses: actions/checkout@v4

- id: rm
  uses: FinOps-Open-Cost-and-Usage-Spec/FOCUS_RM_Extraction@v1
  with:
    specification: ./specification
    baseline: ./releases/latest
    output: ./build/requirements_model
    new-version: '1.6'
    strict: true          # fail the build on a content gap

- uses: actions/upload-artifact@v4
  with:
    name: requirements-model
    path: ${{ steps.rm.outputs.output-path }}
```

By default the action runs `validate,extract,verify,diff` in that order, which is the full
pipeline: check the markdown is shaped as expected, generate the model, audit the generation,
then measure how much of the published model the extractor actually derived. `commands` selects
a subset, in whatever order you name.

`commands: fixtures` is the exception. It runs the bundled fixture cycle inside the action and
reads nothing from your workspace, so a consumer can smoke-test the wiring before pointing it
at a real specification checkout.

| Input | Default | Meaning |
|---|---|---|
| `commands` | `validate,extract,verify,diff` | Steps to run, in order. Or `fixtures` alone. |
| `specification` | | Folder holding `datasets/`, `attributes/`, `operating_model_conditions/`. |
| `baseline` | | Release folder to diff against. Must contain `model_rules/`. |
| `output` | `rm-output` | Where the generated tree is written. |
| `new-version` | baseline `ModelVersion` | Stamped into `ModelVersionIntroduced` / `ModelVersionRemoved`. |
| `dataset-folders` | (all) | Limit extraction to these dataset folders. |
| `dataset-folder` | `billing_period` | Dataset targeted by the verifier's deep audit. |
| `strict` | `false` | Fail on a diff content gap. Key order and whitespace never fail. |
| `summary` | `false` | Diff prints counts and verdict only. |
| `node-version` | `24` | Empty to reuse the caller's own Node setup. |

Four outputs:

| Output | Values |
|---|---|
| `output-path` | absolute path of the generated tree |
| `verify-result` | `pass`, `fail`, `skipped` |
| `verify-warnings` | count of curation fields left at their defaults |
| `diff-verdict` | `complete`, `content-complete`, `gaps`, `skipped` |

`verify-warnings` is separate from `verify-result` because verify deliberately does not fail on
those warnings, so an exit code alone cannot tell a clean model from one carrying unreviewed
rules. All four are written even when a step failed, since a failing step's verdict is exactly
what a caller wants to read.

Paths in `specification`, `baseline` and `output` resolve against the workspace. The extractor's
own assets (the contract, the check-function lookup, `node_modules`) resolve against the action
checkout, so the two never collide.

### Pinning

Releases are tagged `vMAJOR.MINOR.PATCH`, and the release workflow force-moves a floating major
tag (`v1`) onto each one. Pin `@v1` to take fixes automatically, or pin a commit SHA with the
tag in a trailing comment for a reproducible build that Dependabot can still bump:

```yaml
uses: FinOps-Open-Cost-and-Usage-Spec/FOCUS_RM_Extraction@<sha>  # v1.2.0
```

While the action is pre-1.0, releases are tagged `v0.x.y` and published as prereleases. `v0`
moves with them but carries no stability promise: the inputs may change between 0.x releases.
Pin an exact tag until `v1.0.0`.

## Contents

The tool lives in `src/`; `action.yml` and `action.sh` at the root wrap it as a GitHub Action.
Paths in the table below are relative to `src/`.

| File | Role |
|---|---|
| `extract_rm.js` | The extractor. Reads spec markdown, writes `output/model_rules/` (`--baseline` / `--output` relocate either end). |
| `verify.js` | Correctness audit of the generated output (structural + deep transformation). |
| `validate_markdown.js` | Pre-flight check that spec markdown is shaped as the extractor expects. |
| `markdown_util.js` | Shared helpers (inline rendering, entity decoding, path naming) used by all three. |
| `cli.js` | Shared `--specification` / `--baseline` / `--output` parsing, so the three scripts agree on what each folder means. |
| `check_function_lookup.json` | Maps requirement sentences to check functions. Owned by the extractor, not by a release (see below). |
| `requirements_model_contract.json` | Declares where each entity type lives in the spec and which headings to read. |
| `*.test.js` | Node built-in test-runner tests for the utilities, the CLI, and the verifier. |
| `test/fixtures/` | A self-contained spec tree and frozen baseline, so the tests run without a spec checkout (see `test/fixtures/README.md`). |
| `output/` | Generated rule files (see `output/README.md`). |

### The check-function lookup

`check_function_lookup.json` maps a normalized requirement sentence, with the entity name
replaced by `{entity}`, to a fragment of the rule that sentence should produce:

```json
"{entity} MUST be of type String.": {
  "Function": "Type",
  "ValidationCriteria": {
    "Requirement": { "CheckFunction": "TypeString", "ColumnName": "{entity}" }
  }
}
```

A value is written in the same shape as an emitted rule, and **any key it defines is applied to
that rule verbatim**. So an entry is not limited to a `Requirement`: it can set `Notes`, force a
`Type`, supply a `Condition` or `Dependencies`, or override `Function`, using the field names the
rule itself uses. Keys the entry omits keep their derived values, objects merge key by key, and
arrays and scalars replace outright.

The fragment is applied after the rule is derived from the sentence, but it yields to curation
carried from a matched baseline rule: that curation is a decision recorded against this exact
sentence in the published model, which a generic pattern should not undo.

Entries in the pre-1.6 flat shape, `{ "function": ..., "requirement": ... }`, are still read and
converted on load, with a count reported so a release copy can be migrated. The published 1.5
lookup is in that older shape.

It belongs to the extractor rather than to a release. The entries are generic sentence
templates describing how the extractor reads English, not statements about any one model
version, and in practice the file was only ever written once, into 1.5: releases 1.2 through
1.4 carry a `check_functions.json` but no lookup.

A baseline may still carry its own `check_function_lookup.json`. Entries in it merge over the
extractor's, so a release can correct or extend a pattern without a tool change, and every
override is listed in the run summary.

The mapping's *targets* are release data, though: a `CheckFunction` only means anything if the
release being extracted against declares it in `check_functions.json`. After each run the
extractor reports any check function it actually emitted that the baseline's catalog does not
define. Only mappings the run consumed are checked, since the lookup is a superset covering
every dataset.

The lookup is consulted only for sentences the baseline does not already carry: when a rule's
`MustSatisfy` matches an Active baseline rule, that rule's curated Requirement is reused and the
lookup is never reached. It is a fallback for new and reworded sentences, not the primary source
of classification.

## Quick start

```bash
cd src
npm install            # installs marked
npm test               # run the unit tests (no spec checkout needed, see Fixtures)

# Against a specification checkout. All three folders default to the layout this
# folder had when it was vendored at specification/requirements_model/extraction.
npm run validate -- --specification /path/to/specification
npm run extract  -- --specification /path/to/specification --baseline /path/to/releases/latest
npm run verify   -- --specification /path/to/specification --baseline /path/to/releases/latest
npm run diff     -- --baseline /path/to/releases/latest --summary
```

Three folders drive every run, and all three are options:

| Option | What it names | Default |
|---|---|---|
| `--specification <folder>` | the markdown to read: the folder holding `datasets/`, `attributes/`, `operating_model_conditions/` | `../../../specification` |
| `--baseline <folder>` | the release to diff against and copy assets from | `../releases/latest` |
| `--output <folder>` | where the generated model is written | `./output` |

`extract_rm.js` and `verify.js` take all three. `validate_markdown.js` reads only the markdown,
so it takes `--specification` alone; `diff_model.js` compares two generated trees and never reads
markdown, so it takes `--baseline` and `--output` (plus its own `--summary` and `--strict`
switches). Pass `--help` to any of them for the full list. Relative paths resolve against the working directory, `--flag=value` works, and
through npm the flags go after `--`.

The three must agree between an extract and the verify that audits it: the verifier
re-derives its expectations from the same markdown and baseline, so pointing it at
different folders compares the output against the wrong inputs.

The baseline can also be selected by name with `BASELINE_DIR`, which reads a folder
under `releases/`. `--baseline` takes a path and wins over it.

```bash
NEW_VERSION=1.6 npm run extract                  # stamp new rules with a bumped version

# Diff against an older release. NEW_VERSION is derived from the baseline, so set it
# explicitly here or new rules are stamped with the old release's version.
BASELINE_DIR=1.4 NEW_VERSION=1.5 npm run extract
DATASET_FOLDERS=billing_period npm run extract   # limit to specific dataset folders
```

`--output` moves the whole generated tree, `model_rules/` and the copied release assets alike.
Pass the same folder to `npm run diff` to compare a redirected run.

## Fixtures

`test/fixtures/` holds a small specification tree and a frozen baseline release, so the
test suite runs with no specification checkout at all. The extraction test is a golden-file
check: it extracts the fixture spec against the fixture baseline, then asserts the verifier
reports zero failures.

```bash
npm run validate:fixtures   # structural check of the fixture markdown
npm run extract:fixtures    # extract fixtures into .fixture-output/
npm run verify:fixtures     # audit .fixture-output/ with the per-check breakdown
npm run diff:fixtures       # compare .fixture-output/ against the frozen baseline
```

`test/fixtures/README.md` covers what the fixture exercises and how to re-snapshot the
baseline when a change to the extractor is meant to move the output.

## What the extraction does, step by step

The extractor (`extract_rm.js`, `main()`) runs the following pipeline. Every step
is driven by `requirements_model_contract.json` so that file locations and
heading names are never hard-coded.

### 1. Load the contract and per-release inputs

* Read `requirements_model_contract.json` — this declares, for each entity type
  (DataModel, Dataset, Column, Attribute, Condition), the spec location, the
  entity type name, the Rule-ID artifact type letter, an optional ID prefix, and
  the heading names that hold the entity ID, display name, and requirements.
  A location or a heading may be written as a list of alternates, newest spelling
  first, so one release of the extractor reads the spec on either side of a rename
  (see [Renames in the specification](#renames-in-the-specification)).
* Load `check_function_lookup.json` from this folder, then merge the baseline's own
  copy over it if it has one. This maps a normalized requirement sentence (with the
  entity name replaced by `{entity}`) to a `{ function, requirement }` pair. Both files
  are optional; absent, the lookup is empty and every leaf falls through to the
  attribute-conformance or unclassified paths.
* Scan `specification/operating_model_conditions/` to build an anchor-to-ConditionId
  map, so that `#operatingmodelconditions.<anchor>` links in the markdown resolve to
  real Condition IDs.

### 2. Walk the entities

Entities are processed in an order that respects dependencies:

1. **DataModel** — `specification/datasets/data_model.md` (single entity).
2. **Attributes** — every `*.md` in `specification/attributes/` that has both an
   ID heading and a Requirements heading (overview files without those are
   skipped). Attributes are processed *before* datasets and columns because a
   column's "MUST conform to <Attribute>" rule needs the attribute's root Rule ID
   to record as a dependency.
3. **Datasets and their Columns** — every dataset folder under
   `specification/datasets/` that contains a `dataset.md`, then each `*.md` under
   that folder's `columns/`.

### 3. Parse each markdown file into a requirement tree

For one entity file (`emit` -> `parseRequirementTree`):

* The `marked` lexer produces an AST.
* The body of the `## Requirements` section is located. Its lead-in paragraph
  (the anchor sentence, e.g. `BillingPeriod MUST adhere to the following
  requirements:`) becomes the tree root, and the nested bullet list becomes the
  tree's children.
* Each bullet's inline tokens are rendered to plain text via
  `markdown_util.renderInline`, which keeps link and emphasis display text and
  decodes HTML entities so the stored text matches the source exactly. Nested
  bullets become child nodes. `#operatingmodelconditions.<anchor>` links on a bullet
  are recorded as that rule's condition anchors.

### 4. Classify each node into a rule

`flattenTree` turns the tree into a pre-order list, then each node is classified
(`classify`) in this precedence order:

1. **Composite** — a node with children becomes an `AND` over its child rules
   (`CheckModelRule` items), and lists those children as `Dependencies`.
2. **Presence** — a leaf matching `MUST include <X>`. For datasets this emits a
   `ColumnPresent` requirement; the data model records the reference generically.
3. **Check-function lookup** — a leaf whose normalized sentence is a key in the
   lookup gets a populated domain `Requirement` (Type, Nullability, Format, etc.),
   with `{entity}` substituted back to the real entity name.
4. **Attribute conformance** — a leaf matching `MUST conform to <Attribute>
   requirements`, where `<Attribute>` is a real generated attribute, records a
   dependency on that attribute's root rule (no inline requirement).
5. **Unclassified** — any remaining leaf is emitted with an empty `Requirement`
   and recorded as a warning so the lookup can be extended.

A rule with a populated `Requirement` is typed `Static`; an empty one is `Dynamic`.
The BCP-14 keyword (`MUST`, `SHOULD NOT`, `MAY`, ...) is extracted from the
sentence, and the status letter (M / O / C) is derived from the keyword and
whether the sentence is conditional (contains `when`).

### 5. Assign stable Rule IDs

Rule IDs are stable across releases (`expandTree`). Format:

* `<DatasetType>-<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` for
  dataset-scoped entities (e.g. `BIP-BillingPeriod-D-004-M`), where the
  `DatasetType` prefix comes from the contract's `DatasetTypes` map.
* `<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` otherwise.

ID assignment:

* The `releases/latest` rule file(s) are loaded as a baseline. If a derived
  rule's requirement text (normalized) matches a baseline rule, that rule's
  existing ID is reused, preserving its `ModelVersionIntroduced`.
* A new requirement takes the next free NumericId above the baseline maximum.
* A baseline rule with no matching requirement in the current markdown is
  **tombstoned**: carried into the output with `Status: "Removed"`,
  `ModelVersionRemoved: <NEW_VERSION>`, and `Order: -1`. A rule already removed
  in the baseline is carried through unchanged.
* Except when that rule's `ModelVersionIntroduced` is `NEW_VERSION`. It was added
  during the current drafting cycle and never published, so a tombstone would
  announce the removal of something no consumer ever saw. It is **dropped** from
  the output instead and reported, since the baseline copy must be deleted by hand.
  Its NumericId stays reserved until that deletion happens.

Output for each entity is sorted by NumericId and written to its own JSON file
under `output/model_rules/`, mirroring the `releases/<v>/model_rules/` layout.

### 6. Report

The extractor prints a per-entity rule count, followed by up to three summaries:

* **Accepted as Dynamic** — a count of sentences with no derivable check function
  that matched a baseline rule already curated with an empty `Requirement`. These
  need no action; the count is printed so the total stays visible.
* **Unpublished removals** — baseline rules introduced in `NEW_VERSION` that are no
  longer in the markdown. These are dropped from the output rather than tombstoned,
  and each is listed with its Rule ID and baseline file because **this output folder
  is not the baseline**: the copy in `releases/latest` has to be deleted by hand.
* **No check-function mapping** — sentences that resolved to neither a check function
  nor a curated baseline `Requirement`, so those sentences can be added to the lookup.

## Completeness (`npm run diff`)

`verify.js` checks that the transformation is internally consistent. `diff_model.js`
answers a different question: **how much of the model can the extractor actually
derive?** An entity is fully derived when its generated file is byte-identical to the
hand-authored copy in `releases/latest`. Anything less is a gap — a missing
check-function mapping, a curated value the sentence cannot express, or a rule the
markdown no longer states.

Entities are matched by mirrored relative path. Each shared entity lands in one bucket:

| Bucket | Meaning |
|---|---|
| `identical (byte-equal)` | Fully derived. |
| `formatting only` | Same rules, same key order, different whitespace. |
| `key order only` | Same rules and values, keys emitted in a different order. |
| `content differs` | Rules added, removed, or changed. |

Baseline entities with no generated counterpart are split by cause, so that only the
last of the three counts as a gap:

* **out of extractor scope** — `conditions/` and `datasets/*/objects/`. The contract
  defines no Objects entity, and conditions markdown is read only for the
  anchor-to-`ConditionId` map.
* **tombstone-only** — every rule is already `Removed` and the markdown is gone, so
  there is nothing left to derive.
* **missing (has active rules)** — a real gap.

The run ends with one verdict line:

* `✅ Model COMPLETE` — every in-scope entity is byte-identical.
* `✅ Content COMPLETE` — all rules and values match; some entities differ only in key
  order or whitespace.
* `❌ Model has gaps: N entities differ … in content` — a real derivation gap.

Only content differences, missing baseline entities, and generated-only entities count
as gaps. Key order and whitespace do not: the hand-authored baseline carries **25
distinct rule key orders**, so byte equality is unreachable until the baseline is
normalized from generated output. Treating that drift as a gap would mean encoding 25
orderings into the generator. `--strict` therefore fails on content gaps only.

For entities that differ, the detail section lists rules present on only one side and,
for changed rules, each differing field as `path: baseline -> generated`.

```bash
npm run diff                  # summary + per-entity detail
npm run diff -- --summary     # counts and verdict only
npm run diff -- --strict      # exit 1 on a content gap (for CI gating)
```

Run `npm run extract` first; the diff reads `output/model_rules/` and does not
regenerate it. `BASELINE_DIR` selects the baseline, exactly as for extraction.

## Verification

`verify.js` audits the generated output in two layers and exits non-zero on any
failure:

* **Structural integrity** over every output file — no duplicate Rule IDs or
  NumericIds, files sorted by NumericId, active-rule dependencies resolve
  (within the file or to external `ATT-*` rules), composite `Items` match
  `Dependencies`, `Keyword` matches the sentence, dataset/column rules carry a
  `DatasetType` and an ID prefixed with it, and no raw HTML entities leaked into
  any `MustSatisfy`.
* **Deep transformation audit** of the `billing_period` dataset file — expected
  rules are independently re-derived from the two inputs (the `releases/latest`
  baseline JSON and the current markdown) and compared against the output,
  checking coverage, ID reuse, `ModelVersionIntroduced`, and tombstoning.

`validate_markdown.js` is a lighter pre-flight check that the spec markdown is
shaped the way the extractor requires (present Requirements section, anchor
paragraph, well-formed bullet list) before extraction is attempted.

## Renames in the specification

The extractor is pinned by tag from the spec repo, so a single release has to read branches on
either side of a rename in the specification. Three things can move: a folder, an entity's ID
heading, and the anchor prefix its links are written with. All three are contract data, and each
accepts a list of alternates with the newest spelling first:

```jsonc
"Conditions": {
  "Location": ["specification/operating_model_conditions/", "specification/conditions/"],
  "AnchorPrefixes": ["operatingmodelconditions", "conditions"],
  "Headings": { "Id": ["Operating Model Condition ID", "Condition ID"], ... }
}
```

The first location that exists on disk wins; a heading is satisfied by any of its spellings; a
link is a condition link under any of the prefixes. Adding a spelling is the whole change, and
the old one stays until no supported branch writes it any more.

Two guards make a rename that the contract has *not* been taught about loud rather than quiet:
a missing entity folder fails with the spellings it looked for, and a folder that yields no
entity at all (every file skipped for want of an ID heading) fails the same way. Without them a
renamed heading extracts "successfully" while tombstoning every rule of that entity kind.

Output paths never follow a spec rename. Conditions are still written to
`model_rules/conditions/`, because that path is the published model's, and moving it would read
as every condition entity having been deleted and re-added.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `BASELINE_DIR` | `latest` | Directory under `releases/` to use as the baseline for stable IDs and curated Requirements. Overridden by `--baseline`. |
| `NEW_VERSION` | baseline's `ModelVersion` | Version stamped into `ModelVersionIntroduced` / `ModelVersionRemoved` for new and tombstoned rules. |
| `DATASET_FOLDERS` | (all) | Comma-separated dataset folders to limit extraction to. |
| `DATASET_FOLDER` | `billing_period` | Dataset file targeted by the `verify.js` deep audit. |

## Releasing

`.github/workflows/ci.yml` runs the unit tests and the fixture cycle on Node 22 and 24 for every
push and pull request, and a second job exercises `action.yml` itself against the fixtures via
`uses: ./`, so a broken action never ships even when the extractor is fine.

To cut a release, tag a commit on `main`:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` then re-runs the fixture cycle through the action on the tagged
commit, force-moves the matching major tag (`v1`) onto it, and publishes a GitHub release with
generated notes. The gate runs before the major tag moves, so a bad tag cannot drag every
`@v1` consumer with it.

The package stays `"private": true`. It is consumed as an action, not from npm, and the flag
keeps an accidental `npm publish` from succeeding.
