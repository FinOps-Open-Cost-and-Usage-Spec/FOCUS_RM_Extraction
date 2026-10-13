'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { itemLabel, sharedPrefix, arrayDiffLines, diffLines, fieldDiffs } = require('./diff_model');

const PAD = '      ';
const dep = (id) => id;
const req = (id) => ({ CheckFunction: 'CheckModelRule', ModelRuleId: id });
const lines = (a, b, label = 'ValidationCriteria.Dependencies') => arrayDiffLines(label, a, b, PAD);

// --- item labels ------------------------------------------------------------

test('a CheckModelRule item labels as its rule id alone', () => {
  assert.equal(itemLabel(req('CAU-SkuPriceDetails-C-034-C')), 'CAU-SkuPriceDetails-C-034-C');
});

test('a string item labels bare, so the shared id prefix is not fenced off by a quote', () => {
  assert.equal(itemLabel('CAU-SkuPriceDetails-C-034-C'), 'CAU-SkuPriceDetails-C-034-C');
});

test('other check functions label as Fn(Key=value), recursing into nested Items', () => {
  assert.equal(
    itemLabel({ CheckFunction: 'CheckColumnValue', ColumnName: 'ChargeCategory', Value: 'Tax' }),
    'CheckColumnValue(ColumnName="ChargeCategory", Value="Tax")');
  assert.equal(
    itemLabel({ CheckFunction: 'CheckAnyOf', Items: [req('X-001-M'), req('X-002-M')] }),
    'CheckAnyOf([X-001-M, X-002-M])');
});

// --- shared prefix ----------------------------------------------------------

test('a shared id prefix is cut back to a separator, and a mixed-entity list keeps full ids', () => {
  assert.equal(sharedPrefix(['ATT-UnitFormat-A-015-O', 'ATT-UnitFormat-A-016-M']), 'ATT-UnitFormat-A-');
  assert.equal(sharedPrefix(['CAU-BillingCurrency-C-001-M', 'CCT-ContractCommitment-D-003-M']), '');
});

// --- the three kinds of list difference -------------------------------------

test('same items in a different order report as ordering only, with both orders shown', () => {
  const out = lines(['ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-002-M', 'ATT-UnitFormat-A-003-M'], ['ATT-UnitFormat-A-003-M', 'ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-002-M']);
  assert.match(out[0], /ordering only, 3 items {2}\[ids under ATT-UnitFormat-A-…\]/);
  assert.equal(out[1].trim(), 'baseline:  001-M, 002-M, 003-M');
  assert.equal(out[2].trim(), 'generated: 003-M, 001-M, 002-M');
  assert.equal(out.length, 3);
});

test('added items report as additions, naming each one', () => {
  const out = lines([req('ATT-UnitFormat-A-001-M')], [req('ATT-UnitFormat-A-001-M'), req('ATT-UnitFormat-A-034-C'), req('ATT-UnitFormat-A-039-C')],
    'ValidationCriteria.Requirement.Items');
  assert.match(out[0], /^ {6}ValidationCriteria\.Requirement\.Items: \+2 added, 1 kept \(1 -> 3 items\)/);
  assert.deepEqual(out.slice(1).map((l) => l.trim()), ['+ 034-C', '+ 039-C']);
});

test('removed items report as deletions', () => {
  const out = lines(['ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-018-O', 'ATT-UnitFormat-A-021-O'], ['ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-021-O']);
  assert.match(out[0], /-1 removed, 2 kept \(3 -> 2 items\)/);
  assert.deepEqual(out.slice(1).map((l) => l.trim()), ['- 018-O']);
});

test('a list that both gains an item and reorders the rest says so', () => {
  const out = lines(['ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-002-M'], ['ATT-UnitFormat-A-002-M', 'ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-003-M']);
  assert.match(out[0], /\+1 added, 2 kept, reordered \(2 -> 3 items\)/);
});

test('a long list of changes collapses its tail into a count', () => {
  const added = Array.from({ length: 15 }, (_, i) => `ATT-UnitFormat-A-${String(i).padStart(3, '0')}-M`);
  const out = lines([], added);
  assert.equal(out.length, 1 + 13);
  assert.equal(out[out.length - 1].trim(), '… and 3 more');
});

test('a long list of ids wraps rather than running off the screen', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `SOME-LONG-ENTITY-${i}-${String(i).padStart(3, '0')}-M`);
  const out = lines(ids, [...ids.slice(1), ids[0]]);
  assert.ok(out.length > 3, 'expected the two orders to wrap onto several lines');
  for (const l of out) assert.ok(l.length <= 115, `line too wide: ${l}`);
});

// --- the scalar paths are left alone ----------------------------------------

test('short scalars still render inline as baseline -> generated', () => {
  assert.deepEqual(diffLines({ path: 'Status', baseline: 'Active', generated: 'Removed' }, PAD),
    [`${PAD}Status: "Active" -> "Removed"`]);
  assert.deepEqual(diffLines({ path: 'ModelVersionRemoved', baseline: undefined, generated: '1.5' }, PAD),
    [`${PAD}ModelVersionRemoved: (absent) -> "1.5"`]);
});

test('two long variants of one sentence align on the part that changed', () => {
  const head = 'FOCUS dataset column MUST include both the date and time components, separated with ';
  const out = diffLines({
    path: 'ValidationCriteria.MustSatisfy',
    baseline: `${head}the letter \`T\`.`,
    generated: `${head}the letter T.`,
  }, PAD);
  assert.equal(out[0], `${PAD}ValidationCriteria.MustSatisfy: text differs at char ${head.length + 12}`);
  assert.match(out[1], /^ {10}baseline: {2}"…/);
  assert.ok(out[1] !== out[2].replace('generated:', 'baseline: '), 'the two sides must differ on screen');
  assert.ok(out[1].includes('`T`') && !out[2].includes('`T`'));
});

test('two unrelated long strings fall back to the plain clipped render', () => {
  const out = diffLines({ path: 'X', baseline: 'a'.repeat(200), generated: 'b'.repeat(200) }, PAD);
  assert.equal(out.length, 1);
  assert.match(out[0], / -> /);
});

// --- wired into the rule comparison -----------------------------------------

test('a reordered Dependencies list surfaces through fieldDiffs as one ordering-only entry', () => {
  const base = { ValidationCriteria: { Dependencies: ['ATT-UnitFormat-A-001-M', 'ATT-UnitFormat-A-002-M'] } };
  const gen = { ValidationCriteria: { Dependencies: ['ATT-UnitFormat-A-002-M', 'ATT-UnitFormat-A-001-M'] } };
  const diffs = fieldDiffs(base, gen);
  assert.equal(diffs.length, 1);
  assert.match(diffLines(diffs[0], PAD)[0], /^ {6}ValidationCriteria\.Dependencies: ordering only, 2 items/);
});
