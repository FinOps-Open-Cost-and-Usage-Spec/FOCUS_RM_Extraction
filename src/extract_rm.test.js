'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { marked } = require('marked');
const { isDeprecatedEntity, deprecateColumnRules, deepMerge, normalizeLookup } = require('./extract_rm');

const HEADINGS = { Requirements: 'Requirements', Id: 'Column ID', DisplayName: 'Display Name', Deprecated: 'Deprecated (version)' };

// Shaped after the real providername.md as it stood while the column was deprecated: the entity
// keeps its Requirements and gains a "Deprecated (version)" section naming the replacement.
const DEPRECATED_MD = `# Provider - DEPRECATED

## Requirements

ProviderName adheres to the following requirements:

* ProviderName MUST be of type String.

## Column ID

ProviderName

## Display Name

Provider Name

## Version Introduced

0.5

## Deprecated (version)

1.3 Replaced by [ServiceProviderName](#datasets.costandusage.serviceprovidername)
`;

const CURRENT_MD = DEPRECATED_MD.replace('# Provider - DEPRECATED', '# Provider')
  .replace(/## Deprecated \(version\)\n\n.*\n/, '');

test('an entity with a populated Deprecated section is deprecated', () => {
  assert.equal(isDeprecatedEntity(marked.lexer(DEPRECATED_MD), HEADINGS), true);
});

test('an entity with no Deprecated section is current', () => {
  assert.equal(isDeprecatedEntity(marked.lexer(CURRENT_MD), HEADINGS), false);
});

test('an empty Deprecated section is current, not deprecated', () => {
  const md = DEPRECATED_MD.replace(/1\.3 Replaced by .*\n/, '');
  assert.equal(isDeprecatedEntity(marked.lexer(md), HEADINGS), false);
});

test('a contract without a Deprecated heading never reports deprecation', () => {
  const { Deprecated, ...withoutDeprecated } = HEADINGS;
  assert.equal(isDeprecatedEntity(marked.lexer(DEPRECATED_MD), withoutDeprecated), false);
});

test('dataset rules about a deprecated column follow it, others are untouched', () => {
  const rules = {
    'CAU-CostAndUsage-D-000-M': { Status: 'Active', EntityId: 'CostAndUsage' },
    'CAU-CostAndUsage-D-021-M': { Status: 'Active', EntityId: 'ProviderName' },
    'CAU-CostAndUsage-D-022-M': { Status: 'Active', EntityId: 'BillingAccountId' },
    'CAU-CostAndUsage-D-023-M': { Status: 'Removed', EntityId: 'ProviderName' },
  };
  deprecateColumnRules(rules, new Set(['ProviderName']));
  assert.equal(rules['CAU-CostAndUsage-D-021-M'].Status, 'Deprecated');
  assert.equal(rules['CAU-CostAndUsage-D-000-M'].Status, 'Active', 'the dataset root stays active');
  assert.equal(rules['CAU-CostAndUsage-D-022-M'].Status, 'Active');
  assert.equal(rules['CAU-CostAndUsage-D-023-M'].Status, 'Removed', 'a removed rule is not resurrected');
});

test('a lookup entry merges over the derived rule key by key', () => {
  const rule = {
    Function: 'Validation',
    Notes: '',
    Type: 'Dynamic',
    ValidationCriteria: { MustSatisfy: 'X MUST be of type String.', Requirement: {}, Dependencies: [] },
  };
  const entry = {
    Function: 'Type',
    Notes: 'from the lookup',
    ValidationCriteria: { Requirement: { CheckFunction: 'TypeString', ColumnName: 'X' } },
  };
  const merged = deepMerge(rule, entry);
  assert.equal(merged.Function, 'Type', 'a key the entry defines wins');
  assert.equal(merged.Notes, 'from the lookup');
  assert.equal(merged.Type, 'Dynamic', 'a key the entry omits is left alone');
  assert.deepEqual(merged.ValidationCriteria.Requirement, { CheckFunction: 'TypeString', ColumnName: 'X' });
  assert.equal(merged.ValidationCriteria.MustSatisfy, 'X MUST be of type String.',
    'nested keys merge rather than replacing the whole object');
  assert.deepEqual(merged.ValidationCriteria.Dependencies, []);
});

test('arrays replace rather than concatenating', () => {
  const merged = deepMerge({ Dependencies: ['A', 'B'] }, { Dependencies: ['C'] });
  assert.deepEqual(merged.Dependencies, ['C']);
});

test('the pre-1.6 lookup shape is converted on load', () => {
  const legacy = {
    '{entity} MUST be of type String.': {
      function: 'Type',
      requirement: { CheckFunction: 'TypeString', ColumnName: '{entity}' },
    },
  };
  assert.deepEqual(normalizeLookup(legacy), {
    '{entity} MUST be of type String.': {
      Function: 'Type',
      ValidationCriteria: { Requirement: { CheckFunction: 'TypeString', ColumnName: '{entity}' } },
    },
  });
});

test('an already rule-shaped entry is left untouched', () => {
  const current = {
    '{entity} MAY be null.': {
      Function: 'Nullability',
      ValidationCriteria: { Requirement: { CheckFunction: 'CheckValue', ColumnName: '{entity}' } },
    },
  };
  assert.deepEqual(normalizeLookup(current), current);
});
