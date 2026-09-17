'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseArgs, specPath, UsageError } = require('./cli');

const FLAGS = ['specification', 'baseline', 'output'];

test('no arguments leaves the baseline and output at their defaults', () => {
  assert.deepEqual(parseArgs([], FLAGS), {});
});

test('--baseline and --output are read as separate arguments', () => {
  assert.deepEqual(parseArgs(['--baseline', '../releases/1.4', '--output', '/tmp/rm'], FLAGS),
    { baseline: '../releases/1.4', output: '/tmp/rm' });
});

test('--flag=value is accepted too', () => {
  assert.deepEqual(parseArgs(['--baseline=../releases/1.4', '--output=/tmp/rm'], FLAGS),
    { baseline: '../releases/1.4', output: '/tmp/rm' });
});

test('a later flag wins over an earlier one', () => {
  assert.deepEqual(parseArgs(['--output', 'a', '--output', 'b'], FLAGS), { output: 'b' });
});

test('--help short-circuits, so a bad flag after it is not an error', () => {
  assert.deepEqual(parseArgs(['--help', '--bogus'], FLAGS), { help: true });
  assert.deepEqual(parseArgs(['-h'], FLAGS), { help: true });
});

test('an unknown option is a usage error', () => {
  assert.throws(() => parseArgs(['--bogus', 'x'], FLAGS), UsageError);
});

test('a flag with no value is a usage error rather than a silent default', () => {
  assert.throws(() => parseArgs(['--baseline'], FLAGS), UsageError);
  assert.throws(() => parseArgs(['--output='], FLAGS), UsageError);
});

test('a flag outside the script\'s own set is rejected', () => {
  // validate_markdown.js accepts only --specification, so --output is not its flag.
  assert.throws(() => parseArgs(['--output', 'x'], ['specification']), UsageError);
});

test('a contract Location resolves against the specification root', () => {
  // Locations stay repo-relative in the contract; --specification names the spec folder itself.
  // The trailing slash of a directory Location survives the join, and is harmless downstream.
  assert.equal(specPath('/spec', 'specification/datasets/'), path.join('/spec', 'datasets') + path.sep);
  assert.equal(specPath('/spec', 'specification/datasets/data_model.md'),
    path.join('/spec', 'datasets', 'data_model.md'));
});

test('a Location written as alternates resolves to the spelling that exists', () => {
  // The conditions folder was renamed to operating_model_conditions/ in the spec; one extractor
  // reads both, so an older branch or release tag still extracts.
  const root = path.join(__dirname, 'test', 'fixtures', 'specification');
  assert.equal(
    specPath(root, ['specification/operating_model_conditions/', 'specification/conditions/']),
    path.join(root, 'operating_model_conditions') + path.sep);
  assert.equal(
    specPath(root, ['specification/conditions/', 'specification/operating_model_conditions/']),
    path.join(root, 'operating_model_conditions') + path.sep);
});

test('alternates with nothing on disk fall back to the first, so the error names it', () => {
  assert.equal(specPath('/spec', ['specification/operating_model_conditions/', 'specification/conditions/']),
    path.join('/spec', 'operating_model_conditions') + path.sep);
});
