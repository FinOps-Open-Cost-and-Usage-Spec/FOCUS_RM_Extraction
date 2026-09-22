'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');
const { isDeprecatedEntity, deprecateColumnRules, deepMerge, normalizeLookup, hasSection, getSectionText, conditionAnchorsOf, functionForSentence } = require('./extract_rm');

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
