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
