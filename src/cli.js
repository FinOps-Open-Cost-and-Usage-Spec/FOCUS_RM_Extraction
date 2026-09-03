'use strict';

/**
 * Shared command-line handling for the three entry points (extract_rm.js, verify.js,
 * validate_markdown.js).
 *
 * All three read the same two things from outside this folder: the specification markdown
 * and a baseline release. Both used to be reached through a hardcoded `../../..`, which only
 * resolved while this folder was vendored inside the FOCUS specification repo at
 * specification/requirements_model/extraction. Centralizing the flags here keeps the three
 * scripts agreeing on what `--specification` means, which matters because verify.js re-derives
 * from the same markdown extract_rm.js consumed.
 */

const path = require('path');

/**
 * The specification tree as it sat when this folder lived inside the spec repo. Kept as the
 * default so an in-repo checkout still works with no arguments; standalone checkouts pass
 * --specification.
 */
const DEFAULT_SPEC_ROOT = path.resolve(__dirname, '..', '..', '..', 'specification');

/** A bad invocation, reported as a usage message rather than a stack trace. */
class UsageError extends Error {}

/**
 * Parse long options: `flags` each take a folder, `booleans` are bare switches set to true.
 *
 * Both `--flag value` and `--flag=value` are accepted; `-h`/`--help` short-circuits to
 * `{ help: true }` so a help request is never rejected for the flags that follow it. Unknown
 * options and empty values raise UsageError.
 *
 * Callers invoke this from main() rather than at load time, so that requiring one of these
 * scripts as a library does not consume the argv of whatever required it (the test runner's,
 * in practice).
 */
function parseArgs(argv, flags, booleans = []) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!name.startsWith('--')) throw new UsageError(`Unknown option: ${arg}`);
    const key = name.slice(2);
    if (booleans.includes(key)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      opts[key] = true;
      continue;
    }
    if (!flags.includes(key)) throw new UsageError(`Unknown option: ${arg}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (!value) throw new UsageError(`${name} requires a folder`);
    opts[key] = value;
  }
  return opts;
}

/**
 * Resolve a contract Location against a specification tree root.
 *
 * Locations in requirements_model_contract.json are written relative to the spec repo root
 * ("specification/datasets/"), while --specification names the specification folder itself, so
 * the leading segment is dropped. Keeping the contract repo-relative means it still reads as a
 * map of where entities live in the published repo.
 */
function specPath(specRoot, location) {
  return path.join(specRoot, location.replace(/^specification[\\/]/, ''));
}

/** Run an entry point, printing UsageError as a usage message; real failures keep their stack. */
function runMain(main, usage) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${usage}`);
    process.exit(2);
  }
}

module.exports = { DEFAULT_SPEC_ROOT, UsageError, parseArgs, specPath, runMain };
