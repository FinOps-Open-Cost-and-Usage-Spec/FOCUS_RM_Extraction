'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runVerify } = require('./verify');

const SPEC = path.join(__dirname, 'test', 'fixtures', 'specification');
const BASELINE = path.join(__dirname, 'test', 'fixtures', 'baseline');

test('extractor output passes all verification checks', (t) => {
  // Extract the fixture specification against the frozen fixture baseline, then assert the
  // audit (structural + transformation) reports no failures. The baseline is a snapshot of a
  // previous run over the same markdown, so this is a golden-file check: any change to the
  // extractor that moves a rule ID, an Order, or a MustSatisfy sentence shows up here.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-extract-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  execFileSync(process.execPath,
    ['extract_rm.js', '--specification', SPEC, '--baseline', BASELINE, '--output', out],
    { cwd: __dirname, stdio: 'ignore' });

  const { fail } = runVerify({ silent: true, specification: SPEC, baseline: BASELINE, output: out });
  assert.equal(fail, 0, 'verify reported failures — run `npm run verify:fixtures` for the per-check breakdown');
});

// --- the Condition failure's diagnosis --------------------------------------
//
// The check itself is covered by the fixture run above. These cover what it prints when it
// fails: the whole point of the report is to name where the missing curation was supposed to
// come from, and each cause is reached only by a baseline shape the fixtures do not hold.

const { parseWhenClause, expectedConditionSketch, reportMissingConditions } = require('./verify');

const COLUMNS = new Set(['CredentialId', 'ChargeCategory']);

test('a clause naming columns and literals parses; prose does not', () => {
  assert.equal(parseWhenClause('When the charge is not invoiced, X MUST be null.', COLUMNS), null);
  assert.equal(parseWhenClause('When UnknownColumn is null, X MUST be null.', COLUMNS), null);
  const one = parseWhenClause('When CredentialId is not null, X MUST be null.', COLUMNS);
  assert.deepEqual(one.terms, [{ column: 'CredentialId', negated: true, value: null }]);
  const two = parseWhenClause('When CredentialId is null or ChargeCategory is "Tax", X MUST be null.', COLUMNS);
  assert.equal(two.operator, 'OR');
  assert.equal(two.terms.length, 2);
});

test('the expected Condition is sketched in the published shape', () => {
  const one = parseWhenClause('When CredentialId is not null, X MUST be null.', COLUMNS);
  assert.deepEqual(expectedConditionSketch(one),
    { CheckFunction: 'CheckNotValue', ColumnName: 'CredentialId', Value: null });
  const two = parseWhenClause('When CredentialId is null or ChargeCategory is "Tax", X MUST be null.', COLUMNS);
  assert.deepEqual(expectedConditionSketch(two).CheckFunction, 'OR');
  assert.deepEqual(expectedConditionSketch(two).Checks[1],
    { CheckFunction: 'CheckValue', ColumnName: 'ChargeCategory', Value: 'Tax' });
});

test('each cause is named from the baseline shape that produced it', () => {
  const sentence = 'When CredentialId is not null, CredentialId MUST adhere to the following requirements:';
  const id = 'CAU-CredentialId-C-007-C';
  const file = 'datasets/cost_and_usage/columns/credentialid.json';
  const offender = [{ id, rule: { ValidationCriteria: { MustSatisfy: sentence } }, when: parseWhenClause(sentence, COLUMNS) }];

  const report = (ctx) => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { reportMissingConditions(offender, { ruleFile: { [id]: file }, ...ctx }); }
    finally { console.log = real; }
    return lines.join('\n');
  };

  assert.match(report({ baselineRules: {}, baselineFiles: new Set() }), /new entity/);
  assert.match(report({ baselineRules: {}, baselineFiles: new Set([file]) }), /new rule/);
  const withCondition = { [id]: { ValidationCriteria: { MustSatisfy: sentence, Condition: { CheckFunction: 'CheckNotValue' } } } };
  assert.match(report({ baselineRules: withCondition, baselineFiles: new Set([file]) }), /did not survive this run/);
  const reworded = { [id]: { ValidationCriteria: { MustSatisfy: 'When CredentialId is null, X MUST be null.', Condition: { CheckFunction: 'CheckValue' } } } };
  assert.match(report({ baselineRules: reworded, baselineFiles: new Set([file]) }), /its sentence\s+differs/);
  const empty = { [id]: { ValidationCriteria: { MustSatisfy: sentence, Condition: {} } } };
  assert.match(report({ baselineRules: empty, baselineFiles: new Set([file]) }), /gap predates this run/);
});
