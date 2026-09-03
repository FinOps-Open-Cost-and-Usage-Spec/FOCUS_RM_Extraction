'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateEntity, collectErrors } = require('./validate_markdown');

const SPEC = path.join(__dirname, 'test', 'fixtures', 'specification');

const HEADINGS = { Requirements: 'Requirements', Id: 'Column ID', DisplayName: 'Display Name' };

// A well-formed column markdown fixture used as the baseline for negative tests.
const GOOD = `# Billing Period Start

Intro text.

## Requirements

BillingPeriodStart MUST adhere to the following requirements:

* BillingPeriodStart MUST be of type Date/Time.
* BillingPeriodStart MUST NOT be null.

## Column ID

BillingPeriodStart

## Display Name

Billing Period Start
`;

test('a well-formed entity produces no errors', () => {
  assert.deepEqual(validateEntity(GOOD, 'good.md', HEADINGS), []);
});

// Guards the fixture tree the extractor tests run against: if it ever drifts into a shape the
// extractor would reject, this fails before the extraction test does, and says which line.
// Point --specification at a real spec checkout to run the same sweep over the published source.
test('the fixture specification markdown is structurally valid', () => {
  const errors = collectErrors(SPEC);
  assert.deepEqual(errors, [], errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n'));
});

test('missing Requirements section is reported', () => {
  const md = GOOD.replace('## Requirements', '## Notes');
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  assert.ok(errors.some((e) => /Missing required "## Requirements"/.test(e.message)));
});

test('non-PascalCase Column ID is reported with its line', () => {
  const md = GOOD.replace('BillingPeriodStart\n\n## Display Name', 'Billing Period Start\n\n## Display Name');
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  const hit = errors.find((e) => /must be PascalCase/.test(e.message));
  assert.ok(hit, 'expected a PascalCase error');
  assert.equal(hit.line, 14); // the value line under "## Column ID"
});

test('a bullet without a BCP-14 keyword is reported at its line', () => {
  const md = GOOD.replace('* BillingPeriodStart MUST NOT be null.', '* BillingPeriodStart is never null.');
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  const hit = errors.find((e) => /no BCP-14 keyword/.test(e.message));
  assert.ok(hit, 'expected a BCP-14 error');
  assert.equal(hit.line, 10); // second bullet
});

test('a non-asterisk bullet marker is reported', () => {
  const md = GOOD.replace('* BillingPeriodStart MUST be of type Date/Time.', '- BillingPeriodStart MUST be of type Date/Time.');
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  assert.ok(errors.some((e) => /must use a "\*" marker/.test(e.message)));
});

test('a malformed Requirements anchor is reported', () => {
  const md = GOOD.replace(
    'BillingPeriodStart MUST adhere to the following requirements:',
    'BillingPeriodStart has the following requirements.'
  );
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  assert.ok(errors.some((e) => /anchor must end with/.test(e.message)));
});

test('an empty Id section is reported', () => {
  const md = GOOD.replace('\nBillingPeriodStart\n\n## Display Name', '\n\n## Display Name');
  const errors = validateEntity(md, 'bad.md', HEADINGS);
  assert.ok(errors.some((e) => /has no value/.test(e.message) || /Missing required "## Column ID"/.test(e.message)));
});
