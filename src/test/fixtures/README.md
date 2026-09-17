# Test fixtures

A self-contained specification tree and a frozen baseline release, so the extractor can be
tested without a checkout of the FOCUS specification repo.

```
specification/    the markdown the extractor reads (--specification)
baseline/         the release it diffs against and copies assets from (--baseline)
```

## What the fixture covers

`specification/` is deliberately small: one dataset with three columns, two attributes, and one
condition. It is sized to exercise every path the audit checks rather than to mirror the real
spec:

| Fixture | Exercises |
|---|---|
| `datasets/data_model.md` | a DataModel presence rule referencing a dataset |
| `datasets/billing_period/dataset.md` | dataset presence rules, and the synthesized columns composite |
| `columns/*.md` | check-function classification (`Type`, `Nullability`) and `MUST conform to <Attribute>` links |
| `attributes/*.md` | attribute entities that columns depend on |
| `operating_model_conditions/*.md` | condition entities and the anchor-to-ConditionId map |

The condition folder and its `Operating Model Condition ID` heading use the spelling the spec
adopted in 2026; the legacy `conditions/` and `Condition ID` spellings the contract still accepts
are covered by unit tests rather than by a second fixture tree.

The dataset ID is `BillingPeriod` because `requirements_model_contract.json` maps it to the
`BIP` rule-ID prefix, which the verifier asserts on every dataset-scoped rule. Sentences avoid
the word "when": a machine-checkable `When ...` clause with no curated Condition is a hard
verify failure, and curation is out of scope for a fixture.

## Regenerating the baseline

`baseline/model_rules/` is a snapshot of the extractor's own output over `specification/`, which
makes the extraction test a golden-file check. Any change to the extractor that moves a rule ID,
an Order, or a MustSatisfy sentence will fail the test rather than silently changing the model.

When a change to the extractor is *meant* to move the output, re-snapshot it:

```bash
# From src/. Extract against the current baseline, eyeball the diff, then freeze it.
node extract_rm.js --specification test/fixtures/specification \
                   --baseline test/fixtures/baseline \
                   --output /tmp/rm-fixture
diff -ru test/fixtures/baseline/model_rules /tmp/rm-fixture/model_rules
rm -rf test/fixtures/baseline/model_rules
cp -R /tmp/rm-fixture/model_rules test/fixtures/baseline/model_rules
```

To bootstrap from nothing (no baseline at all), replace `baseline/model_rules/` with an empty
directory first: every rule then comes out as new, stamped with the `ModelVersion` in
`baseline/model_details.json`.

## Check functions

The fixture has no `check_function_lookup.json` of its own: it inherits the extractor's, at
`../../check_function_lookup.json`. `baseline/check_functions.json` holds the eight functions the
fixture actually emits, copied verbatim from a real release catalog, so the extractor's
"names a function the baseline does not define" check runs on every fixture extraction and stays
silent. Do not hand-write entries in either file: an invented check-function name teaches the
wrong vocabulary to anyone reading the fixture as an example.

A lookup value is a rule fragment, so any key it defines lands on the emitted rule verbatim. The
fixture only exercises `Function` and `ValidationCriteria.Requirement`; the merge itself is
covered by unit tests in `extract_rm.test.js`.

Two sentence shapes are deliberately left unmapped by the lookup, so both classification paths
stay covered:

- `MUST conform to NullHandling requirements.` — `NullHandling` is absent from the lookup, so the
  sentence falls through to the attribute-dependency path and the rule gains an `ATT-*`
  dependency. `StringHandling` and `DateTimeFormat` *are* in the lookup, so those sentences are
  classified instead and gain no dependency. The fixture carries both on purpose.
- The attribute and condition sentences have no mapping at all, so they emit an empty
  `Requirement`, are marked `Dynamic`, and warn. That mirrors how real attributes behave, and
  warnings do not fail the audit.
