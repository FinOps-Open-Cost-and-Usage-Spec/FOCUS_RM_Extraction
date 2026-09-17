#!/usr/bin/env bash
#
# Entry point for the composite action in action.yml.
#
# The extractor resolves its own assets (contract, check-function lookup, node_modules)
# against the script's own directory, and every caller-supplied folder against the working
# directory. So this runs node with absolute script paths while staying in the consumer's
# workspace, and the --specification / --baseline / --output values stay workspace-relative
# exactly as the caller wrote them.
set -euo pipefail

SRC="${ACTION_PATH:?ACTION_PATH is not set}/src"

COMMANDS="${INPUT_COMMANDS:-}"
SPECIFICATION="${INPUT_SPECIFICATION:-}"
BASELINE="${INPUT_BASELINE:-}"
OUTPUT="${INPUT_OUTPUT:-}"
STRICT="${INPUT_STRICT:-false}"
SUMMARY="${INPUT_SUMMARY:-false}"

# Extractor knobs that have no flag, only an environment variable.
export NEW_VERSION="${INPUT_NEW_VERSION:-}"
export DATASET_FOLDERS="${INPUT_DATASET_FOLDERS:-}"
export DATASET_FOLDER="${INPUT_DATASET_FOLDER:-billing_period}"
if [ -z "$NEW_VERSION" ]; then unset NEW_VERSION; fi
if [ -z "$DATASET_FOLDERS" ]; then unset DATASET_FOLDERS; fi

# GITHUB_OUTPUT is absent outside Actions, which is how the script stays runnable locally.
# Nothing is written to GITHUB_STEP_SUMMARY: the outputs carry the verdicts, and how they are
# presented is the calling workflow's decision, not this action's.
emit() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi; }
die()  { printf '::error::%s\n' "$1" >&2; exit 2; }

# Written on every exit path, including a --strict failure: "gaps" is precisely the verdict a
# caller wants to read, and the step that produced it has failed by then.
output_abs=""
verdict="skipped"
verify_result="skipped"
verify_warnings=""
finish() {
  emit output-path "$output_abs"
  emit diff-verdict "$verdict"
  emit verify-result "$verify_result"
  emit verify-warnings "$verify_warnings"
}
trap finish EXIT

require() {
  [ -n "$2" ] || die "'$3' step needs the '$1' input."
  [ -d "$2" ] || die "$1 folder not found: $2 (resolved against $PWD)"
}

# Split the comma-separated list, trimming whitespace, preserving the caller's order. The
# expansion is guarded because bash 3.2, which is what macOS ships, treats an empty array under
# `set -u` as unbound: an empty input would abort here rather than reaching the message below.
IFS=',' read -ra RAW <<< "$COMMANDS"
STEPS=()
for c in ${RAW[@]+"${RAW[@]}"}; do
  c="$(printf '%s' "$c" | tr -d '[:space:]')"
  if [ -n "$c" ]; then STEPS+=("$c"); fi
done
[ ${#STEPS[@]} -gt 0 ] || die "The 'commands' input is empty."

for c in "${STEPS[@]}"; do
  case "$c" in
    validate|extract|verify|diff|fixtures) ;;
    *) die "Unknown command '$c'. Expected validate, extract, verify, diff or fixtures." ;;
  esac
done

# 'fixtures' is the self-contained smoke test and brings its own spec and baseline, so it
# never mixes with steps that read the consumer's workspace.
if printf '%s\n' "${STEPS[@]}" | grep -qx fixtures; then
  [ ${#STEPS[@]} -eq 1 ] || die "'fixtures' runs the bundled cycle and cannot be combined with other commands."
fi

diff_flags=()
if [ "$SUMMARY" = "true" ]; then diff_flags+=(--summary); fi
if [ "$STRICT" = "true" ]; then diff_flags+=(--strict); fi

if [ -n "$OUTPUT" ]; then
  mkdir -p "$OUTPUT"
  output_abs="$(cd "$OUTPUT" && pwd)"
fi

for c in "${STEPS[@]}"; do
  echo "::group::$c"
  case "$c" in
    fixtures)
      ( cd "$SRC" \
        && npm test \
        && npm run validate:fixtures \
        && npm run extract:fixtures \
        && npm run verify:fixtures \
        && npm run diff:fixtures )
      ;;

    validate)
      require specification "$SPECIFICATION" validate
      node "$SRC/validate_markdown.js" --specification "$SPECIFICATION"
      ;;

    extract)
      require specification "$SPECIFICATION" extract
      require baseline "$BASELINE" extract
      [ -n "$OUTPUT" ] || die "'extract' needs the 'output' input."
      node "$SRC/extract_rm.js" \
        --specification "$SPECIFICATION" --baseline "$BASELINE" --output "$OUTPUT"
      ;;

    verify)
      require specification "$SPECIFICATION" verify
      require baseline "$BASELINE" verify
      [ -n "$OUTPUT" ] || die "'verify' needs the 'output' input."
      # The warning count is reported separately from pass/fail. Warnings are curation fields
      # left at their defaults, which verify deliberately does not fail on, so a caller that
      # only sees the exit code cannot tell a clean model from one with 88 unreviewed rules.
      set +e
      node "$SRC/verify.js" \
        --specification "$SPECIFICATION" --baseline "$BASELINE" --output "$OUTPUT" \
        | tee "${RUNNER_TEMP:-/tmp}/rm-verify.log"
      status=${PIPESTATUS[0]}
      set -e
      summary="$(grep -E '^[0-9]+ checks passed,' "${RUNNER_TEMP:-/tmp}/rm-verify.log" | tail -1)"
      verify_warnings="$(printf '%s' "$summary" | sed -n 's/.*, \([0-9][0-9]*\) warning(s)\..*/\1/p')"
      if [ "$status" -eq 0 ]; then verify_result="pass"; else verify_result="fail"; fi
      [ "$status" -eq 0 ] || exit "$status"
      ;;

    diff)
      require baseline "$BASELINE" diff
      [ -n "$OUTPUT" ] || die "'diff' needs the 'output' input."
      # --strict exits 1 on a content gap. Capture the verdict either way, then re-raise,
      # so a gating run still reports what it found before it fails the job.
      set +e
      node "$SRC/diff_model.js" --baseline "$BASELINE" --output "$OUTPUT" ${diff_flags[@]+"${diff_flags[@]}"} \
        | tee "${RUNNER_TEMP:-/tmp}/rm-diff.log"
      status=${PIPESTATUS[0]}
      set -e
      log="${RUNNER_TEMP:-/tmp}/rm-diff.log"
      if   grep -q 'Model COMPLETE' "$log";   then verdict="complete"
      elif grep -q 'Content COMPLETE' "$log"; then verdict="content-complete"
      elif grep -q 'Model has gaps' "$log";   then verdict="gaps"
      fi
      [ "$status" -eq 0 ] || exit "$status"
      ;;
  esac
  echo "::endgroup::"
done
