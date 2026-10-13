'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');
const { isDeprecatedEntity, completePresenceConditions, deprecateColumnRules, deepMerge, normalizeLookup, hasSection, getSectionText, conditionAnchorsOf, conditionPhrasesOf, linkPresenceRule, linkMentionedEntities, datasetDepsLast, depsFollowOrder, functionForSentence } = require('./extract_rm');

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

// The spec renamed the condition entity's ID heading to "Operating Model Condition ID" and its
// link anchors to #operatingmodelconditions. Both spellings stay readable: the extractor is
// pinned by tag from the spec repo, so one release has to handle a branch on either side of the
// rename. A heading that resolves neither way is not an error but a skipped file, which is why
// the old spelling cannot simply be dropped.
const CONDITION_ID_HEADING = ['Operating Model Condition ID', 'Condition ID'];

const CONDITION_MD = (heading) => `# Includes Regions

## Requirements

IncludesRegions MUST adhere to the following requirements:

* IncludesRegions MUST be true if the provider offers regional resources.

## ${heading}

IncludesRegions

## Display Name

Includes Regions
`;

for (const heading of CONDITION_ID_HEADING) {
  test(`a "${heading}" section satisfies the condition ID heading`, () => {
    const tokens = marked.lexer(CONDITION_MD(heading));
    assert.equal(hasSection(tokens, CONDITION_ID_HEADING), true);
    assert.equal(getSectionText(tokens, CONDITION_ID_HEADING), 'IncludesRegions');
  });
}

test('a file with neither spelling is skipped, not read as an entity', () => {
  const tokens = marked.lexer(CONDITION_MD('Something Else Entirely'));
  assert.equal(hasSection(tokens, CONDITION_ID_HEADING), false);
});

test('the heading error names every spelling that would have satisfied it', () => {
  const tokens = marked.lexer(CONDITION_MD('Something Else Entirely'));
  assert.throws(() => getSectionText(tokens, CONDITION_ID_HEADING),
    /Operating Model Condition ID" or "Condition ID/);
});

test('condition links are collected under either anchor prefix', () => {
  const md = '* Column MUST be null unless [Includes Regions](#operatingmodelconditions.includesregions) ' +
    'and [Includes Sub Accounts](#conditions.includessubaccounts) hold.';
  const paragraph = marked.lexer(md)[0].items[0].tokens[0];
  assert.deepEqual(conditionAnchorsOf(paragraph.tokens), ['includesregions', 'includessubaccounts']);
});

test('links to other entity kinds are not read as conditions', () => {
  const md = '* Column MUST conform to [Null Handling](#attributes.nullhandling) and ' +
    '[Billing Currency](#datasets.costandusage.billingcurrency).';
  const paragraph = marked.lexer(md)[0].items[0].tokens[0];
  assert.deepEqual(conditionAnchorsOf(paragraph.tokens), []);
});

// The spec links a condition only on its first use in a page, so every later sentence gating on
// one names it in prose alone. Reading anchors only emitted those rules ungated, and half-gated
// the sentences that link one condition and spell out another.

const PHRASES = [
  { id: 'IncludesPricingBillingCurrencyDifferences', phrase: 'includes pricing and billing currency differences' },
  { id: 'IncludesResourceTypeAssignment', phrase: 'includes resource type assignment' },
  { id: 'IncludesProvisionedResources', phrase: 'includes provisioned resources' },
  { id: 'IncludesConsumptionCurrency', phrase: 'includes consumption currency' },
  { id: 'IncludesUnitPricing', phrase: 'includes unit pricing' },
  { id: 'IncludesSubAccounts', phrase: 'includes sub accounts' },
  // No two display names the spec defines today contain one another, so this one stands in for
  // the collision a future condition can introduce at any time.
  { id: 'IncludesUnitPricingDifferences', phrase: 'includes unit pricing differences' },
  // Sorted as loadConditions() sorts, so the overlap case below is exercised the way it runs.
].sort((a, b) => b.phrase.length - a.phrase.length)
  .map(({ id, phrase }) => ({ id, re: new RegExp(`\\b${phrase}\\b`, 'g') }));

test('a condition named in prose is read, not only one that is linked', () => {
  assert.deepEqual(
    conditionPhrasesOf('CostAndUsage MUST include SkuId when the operating model includes unit pricing.', PHRASES),
    ['IncludesUnitPricing']
  );
});

test('a sentence that links one condition and spells out another yields both, in reading order', () => {
  assert.deepEqual(
    conditionPhrasesOf('CostAndUsage MUST include PricingCurrencyContractedUnitPrice when the operating '
      + 'model includes consumption currency and includes unit pricing.', PHRASES),
    ['IncludesConsumptionCurrency', 'IncludesUnitPricing']
  );
});

test('a longer display name wins over a shorter one it contains', () => {
  assert.deepEqual(
    conditionPhrasesOf('CostAndUsage MUST include ListUnitPrice when the operating model includes '
      + 'unit pricing differences.', PHRASES),
    ['IncludesUnitPricingDifferences']
  );
});

test('a sentence with no operating model clause yields nothing', () => {
  assert.deepEqual(
    conditionPhrasesOf('SkuPriceDetails MUST NOT include TokenDirection when the SKU Price includes unit pricing.', PHRASES),
    []
  );
});

test('matching is repeatable: the shared phrase patterns do not carry state between sentences', () => {
  const sentence = 'CostAndUsage MUST include SkuMeter when the operating model includes unit pricing.';
  assert.deepEqual(conditionPhrasesOf(sentence, PHRASES), ['IncludesUnitPricing']);
  assert.deepEqual(conditionPhrasesOf(sentence, PHRASES), ['IncludesUnitPricing']);
});

// A column's root composite is tied to the dataset rule governing the column's presence: it
// depends on that rule, and inherits whatever gates it. Without the inheritance the gate is
// stated once on the dataset side and nowhere on the column, so a consumer reading the column
// alone applies its rules unconditionally.

const presenceRoot = (deps, conditions = []) => ({
  Conditions: conditions.slice(),
  ValidationCriteria: { Dependencies: deps.slice() },
});
test('a column root inherits the conditions gating its presence', () => {
  const root = presenceRoot(['CAU-CredentialId-C-001-M']);
  linkPresenceRule(root, 'CAU-CostAndUsage-D-101-C',
    { Order: 1010, Conditions: ['IncludesRequesterAttribution'] });
  assert.deepEqual(root.Conditions, ['IncludesRequesterAttribution']);
});

test('an ungated presence rule leaves the root ungated, overriding a stale baseline list', () => {
  const root = presenceRoot(['CAU-CredentialId-C-001-M'], ['IncludesListUnitPrices']);
  linkPresenceRule(root, 'CAU-CostAndUsage-D-101-C', { Order: 1010, Conditions: [] });
  assert.deepEqual(root.Conditions, []);
});

test('the inherited list is a copy, not the presence rule\'s own array', () => {
  const presence = { Order: 1010, Conditions: ['IncludesRequesterAttribution'] };
  const root = presenceRoot([]);
  linkPresenceRule(root, 'CAU-CostAndUsage-D-101-C', presence);
  root.Conditions.push('IncludesRegions');
  assert.deepEqual(presence.Conditions, ['IncludesRequesterAttribution']);
});

test('the presence dependency goes last, after the root\'s own children', () => {
  const root = presenceRoot(['CAU-CredentialId-C-001-M', 'CAU-CredentialId-C-003-C']);
  linkPresenceRule(root, 'CAU-CostAndUsage-D-101-C', { Order: 20, Conditions: [] });
  assert.deepEqual(root.ValidationCriteria.Dependencies,
    ['CAU-CredentialId-C-001-M', 'CAU-CredentialId-C-003-C', 'CAU-CostAndUsage-D-101-C']);
});

test('a baseline copy of the presence dependency is moved, not duplicated', () => {
  const root = presenceRoot(['CAU-CredentialId-C-001-M', 'CAU-CostAndUsage-D-101-C', 'CAU-CredentialId-C-003-C']);
  linkPresenceRule(root, 'CAU-CostAndUsage-D-101-C', { Order: 20, Conditions: [] });
  assert.deepEqual(root.ValidationCriteria.Dependencies,
    ['CAU-CredentialId-C-001-M', 'CAU-CredentialId-C-003-C', 'CAU-CostAndUsage-D-101-C']);
});

// The composite grouping a column's presence sentences states no condition of its own: each one
// is written on the leaf whose sentence names it. It takes the whole set, so the composite, and
// the column root that inherits from it, say under which circumstances the column is required.

const presenceGroup = (conditions, kids) => {
  const rules = {
    'CAU-CostAndUsage-D-046-C': {
      Function: 'Composite',
      Conditions: conditions.slice(),
      ValidationCriteria: {
        Requirement: {
          CheckFunction: 'AND',
          Items: Object.keys(kids).map((id) => ({ CheckFunction: 'CheckModelRule', ModelRuleId: id })),
        },
      },
    },
  };
  for (const id of Object.keys(kids)) {
    rules[id] = { Function: 'Presence', Status: 'Active', Conditions: kids[id], ValidationCriteria: { Requirement: {} } };
  }
  return rules;
};
const groupConditions = (rules) => {
  completePresenceConditions(rules, { PricingCurrencyContractedUnitPrice: 'CAU-CostAndUsage-D-046-C' });
  return rules['CAU-CostAndUsage-D-046-C'].Conditions;
};

test('a presence composite takes every condition its group states, in markdown order', () => {
  const rules = presenceGroup([], {
    'CAU-CostAndUsage-D-047-C': ['IncludesConsumptionCurrency', 'IncludesUnitPricing'],
    'CAU-CostAndUsage-D-048-C': ['IncludesPricingBillingCurrencyDifferences', 'IncludesUnitPricing'],
    'CAU-CostAndUsage-D-049-O': [],
  });
  assert.deepEqual(groupConditions(rules),
    ['IncludesConsumptionCurrency', 'IncludesUnitPricing', 'IncludesPricingBillingCurrencyDifferences']);
});

test('the group\'s list overrides a stale one carried from the baseline', () => {
  const rules = presenceGroup(['IncludesVirtualCurrency'], {
    'CAU-CostAndUsage-D-047-C': ['IncludesConsumptionCurrency'],
  });
  assert.deepEqual(groupConditions(rules), ['IncludesConsumptionCurrency']);
});

test('a group that states no condition leaves the composite\'s own list alone', () => {
  const rules = presenceGroup(['IncludesVirtualCurrency'], { 'CAU-CostAndUsage-D-047-C': [] });
  assert.deepEqual(groupConditions(rules), ['IncludesVirtualCurrency']);
});

test('a tombstoned member of the group contributes nothing', () => {
  const rules = presenceGroup([], {
    'CAU-CostAndUsage-D-047-C': ['IncludesConsumptionCurrency'],
    'CAU-CostAndUsage-D-048-C': ['IncludesVirtualCurrency'],
  });
  rules['CAU-CostAndUsage-D-048-C'].Status = 'Removed';
  assert.deepEqual(groupConditions(rules), ['IncludesConsumptionCurrency']);
});

test('conditions are gathered through a nested composite', () => {
  const rules = presenceGroup([], { 'CAU-CostAndUsage-D-047-C': ['IncludesConsumptionCurrency'] });
  rules['CAU-CostAndUsage-D-047-C'].Function = 'Composite';
  rules['CAU-CostAndUsage-D-047-C'].ValidationCriteria.Requirement = {
    CheckFunction: 'AND',
    Items: [{ CheckFunction: 'CheckModelRule', ModelRuleId: 'CAU-CostAndUsage-D-048-C' }],
  };
  rules['CAU-CostAndUsage-D-048-C'] = { Function: 'Presence', Status: 'Active', Conditions: ['IncludesUnitPricing'], ValidationCriteria: { Requirement: {} } };
  assert.deepEqual(groupConditions(rules), ['IncludesConsumptionCurrency', 'IncludesUnitPricing']);
});

test('a column governed by a single presence rule is left untouched', () => {
  const rules = { 'CAU-CostAndUsage-D-101-C': { Function: 'Presence', Conditions: ['IncludesRequesterAttribution'], ValidationCriteria: { Requirement: {} } } };
  completePresenceConditions(rules, { CredentialId: 'CAU-CostAndUsage-D-101-C' });
  assert.deepEqual(rules['CAU-CostAndUsage-D-101-C'].Conditions, ['IncludesRequesterAttribution']);
});

// The entries arrive from three passes that cannot see each other, so the invariant is held
// once at the end rather than at each insertion point.

const rootWith = (deps) => ({ ValidationCriteria: { Dependencies: deps.slice() } });

test('a dataset dependency left mid-list by an earlier pass is moved to the end', () => {
  const rules = {
    'IND-BillingAccountId-C-000-M': rootWith([
      'IND-BillingAccountId-C-001-M', 'IND-InvoiceDetail-D-005-M', 'IND-BillingAccountId-C-005-O']),
  };
  datasetDepsLast(rules);
  assert.deepEqual(rules['IND-BillingAccountId-C-000-M'].ValidationCriteria.Dependencies,
    ['IND-BillingAccountId-C-001-M', 'IND-BillingAccountId-C-005-O', 'IND-InvoiceDetail-D-005-M']);
});

test('several dataset dependencies keep their relative order at the end', () => {
  const rules = {
    'CAU-ResourceType-C-000-C': rootWith([
      'CAU-CostAndUsage-D-039-C', 'CAU-ResourceType-C-001-M', 'CAU-CostAndUsage-D-040-C']),
  };
  datasetDepsLast(rules);
  assert.deepEqual(rules['CAU-ResourceType-C-000-C'].ValidationCriteria.Dependencies,
    ['CAU-ResourceType-C-001-M', 'CAU-CostAndUsage-D-039-C', 'CAU-CostAndUsage-D-040-C']);
});

test('a rule that is not a -000- root is left alone', () => {
  const rules = {
    'CAU-ResourceType-C-004-C': rootWith(['CAU-CostAndUsage-D-039-C', 'CAU-ResourceType-C-001-M']),
  };
  datasetDepsLast(rules);
  assert.deepEqual(rules['CAU-ResourceType-C-004-C'].ValidationCriteria.Dependencies,
    ['CAU-CostAndUsage-D-039-C', 'CAU-ResourceType-C-001-M']);
});

// Dependencies on rules about one entity read in that entity's Order. A -D- entry is ordered
// against the dataset's own sentences, so its Order is on a different scale and it stays where
// datasetDepsLast() put it, at the end, however it compares to the column's numbers.

const ordered = (entries) => Object.fromEntries(entries.map(([id, entityId, order]) =>
  [id, { EntityId: entityId, Order: order, ValidationCriteria: { Dependencies: [] } }]));

const withDeps = (rules, id, deps) => {
  rules[id] = { EntityId: rules[id].EntityId, Order: rules[id].Order, ValidationCriteria: { Dependencies: deps.slice() } };
  depsFollowOrder(rules);
  return rules[id].ValidationCriteria.Dependencies;
};

const BILLING_CURRENCY = () => ordered([
  ['CCT-BillingCurrency-C-000-M', 'BillingCurrency', 0],
  ['CCT-BillingCurrency-C-004-C', 'BillingCurrency', 50],
  ['CCT-BillingCurrency-C-005-M', 'BillingCurrency', 60],
  ['CCT-BillingCurrency-C-006-M', 'BillingCurrency', 70],
  ['CCT-ContractCommitment-D-003-M', 'BillingCurrency', 50],
  ['CCT-ContractCommitment-D-002-M', 'ContractCommitment', -1],
  ['CCT-ContractCommitmentCategory-C-000-M', 'ContractCommitmentCategory', 0],
]);

test('the column\'s own rules are read into Order', () => {
  const deps = withDeps(BILLING_CURRENCY(), 'CCT-BillingCurrency-C-000-M', [
    'CCT-BillingCurrency-C-006-M', 'CCT-BillingCurrency-C-004-C', 'CCT-BillingCurrency-C-005-M']);
  assert.deepEqual(deps, [
    'CCT-BillingCurrency-C-004-C', 'CCT-BillingCurrency-C-005-M', 'CCT-BillingCurrency-C-006-M']);
});

test('a presence rule stays last, whatever its Order says', () => {
  // D-003-M is Order 50 against the dataset's sentences and C-006-M is Order 70 against the
  // column's: two scales, so the lower number does not mean the entry reads earlier.
  const deps = withDeps(BILLING_CURRENCY(), 'CCT-BillingCurrency-C-000-M', [
    'CCT-BillingCurrency-C-004-C', 'CCT-BillingCurrency-C-005-M', 'CCT-BillingCurrency-C-006-M',
    'CCT-ContractCommitment-D-003-M']);
  assert.deepEqual(deps, [
    'CCT-BillingCurrency-C-004-C', 'CCT-BillingCurrency-C-005-M', 'CCT-BillingCurrency-C-006-M',
    'CCT-ContractCommitment-D-003-M']);
});

test('a dataset rule about another entity keeps its place at the end', () => {
  const deps = withDeps(BILLING_CURRENCY(), 'CCT-BillingCurrency-C-000-M', [
    'CCT-BillingCurrency-C-005-M', 'CCT-BillingCurrency-C-004-C', 'CCT-ContractCommitmentCategory-C-000-M']);
  assert.deepEqual(deps, [
    'CCT-BillingCurrency-C-004-C', 'CCT-BillingCurrency-C-005-M', 'CCT-ContractCommitmentCategory-C-000-M']);
});

test('an entry with no position in the markdown is pinned where it is', () => {
  const deps = withDeps(BILLING_CURRENCY(), 'CCT-BillingCurrency-C-000-M', [
    'CCT-BillingCurrency-C-006-M', 'CCT-ContractCommitment-D-002-M', 'CCT-BillingCurrency-C-004-C']);
  assert.deepEqual(deps, [
    'CCT-BillingCurrency-C-004-C', 'CCT-ContractCommitment-D-002-M', 'CCT-BillingCurrency-C-006-M']);
});

test('an unresolved dependency is left alone', () => {
  const deps = withDeps(BILLING_CURRENCY(), 'CCT-BillingCurrency-C-000-M', [
    'CCT-BillingCurrency-C-006-M', 'ATT-NullHandling-A-000-M', 'CCT-BillingCurrency-C-004-C']);
  assert.deepEqual(deps, [
    'CCT-BillingCurrency-C-004-C', 'ATT-NullHandling-A-000-M', 'CCT-BillingCurrency-C-006-M']);
});

test('the two passes together: dataset entry last, the column\'s own rules in Order', () => {
  const rules = BILLING_CURRENCY();
  rules['CCT-BillingCurrency-C-000-M'].ValidationCriteria.Dependencies = [
    'CCT-BillingCurrency-C-006-M', 'CCT-ContractCommitment-D-003-M',
    'CCT-ContractCommitmentCategory-C-000-M', 'CCT-BillingCurrency-C-004-C'];
  datasetDepsLast(rules);
  depsFollowOrder(rules);
  // The presence rule goes to the end; the two BillingCurrency entries swap into Order; the
  // entry about another column is in neither sequence, so it holds the slot it was left in.
  assert.deepEqual(rules['CCT-BillingCurrency-C-000-M'].ValidationCriteria.Dependencies, [
    'CCT-BillingCurrency-C-004-C', 'CCT-ContractCommitmentCategory-C-000-M',
    'CCT-BillingCurrency-C-006-M', 'CCT-ContractCommitment-D-003-M']);
});

// A requirement that reads another column is evaluated against it, and the spec's model suite
// asserts that every Column/Object EntityId a MustSatisfy names appears in some Dependency.
// Cross-entity dependencies are otherwise only carried from a matched baseline rule, which
// leaves every new or reworded sentence with nothing.

const col = (id, entityId, mustSatisfy, deps = [], extra = {}) => [id, {
  EntityType: 'Column',
  EntityId: entityId,
  Status: 'Active',
  ValidationCriteria: { MustSatisfy: mustSatisfy, Dependencies: deps.slice() },
  ...extra,
}];

const ruleSet = (...entries) => Object.fromEntries(entries);

// The roots the sentences below point at.
const ROOTS = [
  col('CAU-PrincipalId-C-000-C', 'PrincipalId', 'PrincipalId MUST adhere to the following requirements:'),
  col('CAU-CredentialId-C-000-C', 'CredentialId', 'CredentialId MUST adhere to the following requirements:'),
];

test('a rule naming another column gains a dependency on that column\'s root', () => {
  const rules = ruleSet(...ROOTS, col('CAU-RequesterDetails-C-005-C', 'RequesterDetails',
    'RequesterDetails MUST NOT be null when PrincipalId is not null or CredentialId is not null.'));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-RequesterDetails-C-005-C'].ValidationCriteria.Dependencies,
    ['CAU-PrincipalId-C-000-C', 'CAU-CredentialId-C-000-C']);
});

test('added dependencies follow the order the sentence names them', () => {
  const rules = ruleSet(...ROOTS, col('CAU-RequesterDetails-C-006-C', 'RequesterDetails',
    'RequesterDetails MAY be null when CredentialId is null and PrincipalId is null.'));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-RequesterDetails-C-006-C'].ValidationCriteria.Dependencies,
    ['CAU-CredentialId-C-000-C', 'CAU-PrincipalId-C-000-C']);
});

test('a curated dependency on any rule of that column is left alone', () => {
  const rules = ruleSet(...ROOTS, col('CAU-RequesterDetails-C-005-C', 'RequesterDetails',
    'RequesterDetails MUST NOT be null when PrincipalId is not null.',
    ['CAU-PrincipalId-C-004-C']));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-RequesterDetails-C-005-C'].ValidationCriteria.Dependencies,
    ['CAU-PrincipalId-C-004-C']);
});

test('a column naming itself gains nothing', () => {
  const rules = ruleSet(...ROOTS, col('CAU-PrincipalId-C-004-C', 'PrincipalId',
    'PrincipalId MUST be null when the principal has no published identifier.'));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-PrincipalId-C-004-C'].ValidationCriteria.Dependencies, []);
});

test('an EntityId that is only the tail of a longer one is not a mention', () => {
  const rules = ruleSet(
    ...ROOTS,
    col('CAU-ListUnitPrice-C-000-C', 'ListUnitPrice', 'ListUnitPrice MUST adhere to the following requirements:'),
    col('CAU-PricingCurrencyListUnitPrice-C-013-M', 'PricingCurrencyListUnitPrice',
      'PricingCurrencyListUnitPrice MUST represent the suggested unit price for the SKU Price.'));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-PricingCurrencyListUnitPrice-C-013-M'].ValidationCriteria.Dependencies, []);
});

test('a removed column is not a mention, and a removed rule gains nothing', () => {
  const rules = ruleSet(
    col('CAU-PrincipalId-C-000-C', 'PrincipalId', 'PrincipalId MUST adhere to the following requirements:',
      [], { Status: 'Removed' }),
    col('CAU-RequesterDetails-C-005-C', 'RequesterDetails',
      'RequesterDetails MUST NOT be null when PrincipalId is not null.'));
  linkMentionedEntities(rules);
  assert.deepEqual(rules['CAU-RequesterDetails-C-005-C'].ValidationCriteria.Dependencies, []);
});

// An unmapped sentence used to land on Function 'Validation' whatever it said, so rewording a
// format or nullability requirement into a sentence the lookup does not hold renamed its Function
// and broke the specification's own conventions (its model suite asserts both).

test('a sentence about a value\'s shape is named Format', () => {
  assert.equal(
    functionForSentence('ContractCommitmentDurationType SHOULD use the "[Numeric Value] [Unit]" format (e.g., "1 Day").'),
    'Format'
  );
});

test('a sentence about whether a value may be null is named Nullability', () => {
  assert.equal(functionForSentence('PrincipalId MUST be null when a charge is not associated with a principal.'), 'Nullability');
  assert.equal(functionForSentence('AllocatedServiceName MUST NOT be null when AllocatedResourceId is not null.'), 'Nullability');
});

test('a sentence naming the kind of value is named Type', () => {
  assert.equal(
    functionForSentence('RequesterDetails MUST be of type JSON Array (serialized as a String where necessary).'),
    'Type'
  );
});

test('type wins over format, which a type sentence can mention in passing', () => {
  assert.equal(
    functionForSentence('ChargePeriodStart MUST be of type String in the DateTimeFormat format.'),
    'Type'
  );
});

test('a sentence about neither is named Validation', () => {
  assert.equal(functionForSentence('PrincipalId MUST be a unique identifier within the service provider.'), 'Validation');
});

test('"formatted" does not read as a format sentence', () => {
  assert.equal(functionForSentence('CostAndUsage MUST have its split cost allocation method documented.'), 'Validation');
  assert.equal(functionForSentence('Tags MUST use formatting agreed with the practitioner.'), 'Validation');
});

test('nullability wins over format, which a null sentence can mention in passing', () => {
  assert.equal(functionForSentence('ListUnitPrice MUST NOT be null when the unit uses Unit Format.'), 'Nullability');
});

// A renamed folder or a renamed ID heading both used to end extraction quietly: the folder with
// a scandir stack trace, the heading with a run that skipped every condition file and tombstoned
// the entity kind. Both now stop with a message naming what was looked for.

/** Extract over a throwaway copy of the fixture spec, after `mutate` has rearranged it. */
function extractionFailure(mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-extract-'));
  try {
    const spec = path.join(tmp, 'specification');
    fs.cpSync(path.join(__dirname, 'test', 'fixtures', 'specification'), spec, { recursive: true });
    mutate(spec);
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'extract_rm.js'),
        '--specification', spec,
        '--baseline', path.join(__dirname, 'test', 'fixtures', 'baseline'),
        '--output', path.join(tmp, 'output')], { encoding: 'utf8', stdio: 'pipe' });
      return null;
    } catch (err) {
      return { status: err.status, stderr: err.stderr };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a conditions folder under no known name fails, naming both spellings', () => {
  const failure = extractionFailure((spec) =>
    fs.renameSync(path.join(spec, 'operating_model_conditions'), path.join(spec, 'renamed_away')));
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /Conditions folder not found/);
  assert.match(failure.stderr, /specification\/operating_model_conditions\/, specification\/conditions\//);
});

// --- the populated output folder -------------------------------------------
//
// Extraction never deletes, so a second run over a folder holding an earlier run's files leaves
// anything the markdown no longer expresses sitting in the output, where the diff reads it as a
// derived entity rather than a dropped one.

/** Extract the fixture spec into `out`, returning null on success or the failed run's details. */
function extractInto(out, extra = []) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'extract_rm.js'),
      '--specification', path.join(__dirname, 'test', 'fixtures', 'specification'),
      '--baseline', path.join(__dirname, 'test', 'fixtures', 'baseline'),
      '--output', out, ...extra], { encoding: 'utf8', stdio: 'pipe' });
    return null;
  } catch (err) {
    return { status: err.status, stderr: err.stderr };
  }
}

test('extracting into a populated output folder fails, naming what is in the way', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-extract-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'output');

  assert.equal(extractInto(out), null, 'the first run into an absent folder should succeed');
  const stale = path.join(out, 'model_rules', 'conditions', 'droppedcondition.json');
  fs.writeFileSync(stale, '{}');

  const failure = extractInto(out);
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /Output folder is not empty/);
  assert.match(failure.stderr, /model_rules/);
  assert.match(failure.stderr, /--clean/);
  assert.ok(fs.existsSync(stale), 'the refused run must not delete anything');
});

test('--clean removes the stale output so the run is a function of its inputs', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-extract-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'output');

  assert.equal(extractInto(out), null);
  const stale = path.join(out, 'model_rules', 'conditions', 'droppedcondition.json');
  fs.writeFileSync(stale, '{}');

  assert.equal(extractInto(out, ['--clean']), null);
  assert.equal(fs.existsSync(stale), false, '--clean should have dropped the stale entity');
  assert.ok(fs.existsSync(path.join(out, 'model_rules')), 'and still written the model');
});

test('a conditions folder whose files all fail to parse as entities fails', () => {
  const failure = extractionFailure((spec) => {
    const file = path.join(spec, 'operating_model_conditions', 'includesregions.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace('## Operating Model Condition ID', '## Renamed Again ID'));
  });
  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /No condition entities found/);
  assert.match(failure.stderr, /Operating Model Condition ID" or "Condition ID/);
});
