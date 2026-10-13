#!/bin/bash
# The specification's own Requirements Model suite, run over a locally extracted model.
# Local equivalent of the "Model tests" step in FOCUS_Spec's rm_extraction.yml.
#
# Usage: ./model_tests.sh [extracted-model-folder]   (default: ./output)
#
# The harness is staged in a scratch tree because build_json.py and tests/conftest.py both
# anchor to <root>/specification/requirements_model and discover releases by scanning
# releases/, so neither can be pointed at an arbitrary folder. Staging also keeps the real
# releases/1.5 baseline intact for diff.
set -euo pipefail

EXTRACTED="$(cd "${1:-output}" && pwd)"
SOURCE="$(cd ../../FOCUS_Spec/specification/requirements_model && pwd)"
STAGE="${TMPDIR:-/tmp}/rm-model-tests"

# conftest.py reads ROOT as parents[3] of itself, so both intermediate folders are
# load-bearing and the staged tree cannot be flattened.
MODEL="$STAGE/specification/requirements_model"
rm -rf "$STAGE"
mkdir -p "$MODEL/releases"
cp "$SOURCE/build_json.py" "$SOURCE/build_helpers.py" "$MODEL/"
cp -RL "$SOURCE/tests" "$MODEL/tests"

# Name the release for the model's own version, so pytest ids read v1.5 rather than
# something that never appears in the published model.
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Details"]["ModelVersion"])' \
  "$EXTRACTED/model_details.json")"

# -L, not -R: a release's json_schemas/datasets is a symlink out to specification/schemas,
# so copying it as a link leaves it dangling once staged and the build fails resolving the
# file(...) schema references.
cp -RL "$EXTRACTED" "$MODEL/releases/$VERSION"

echo "Testing extracted model $VERSION under the specification's own suite"
cd "$MODEL"
python3 build_json.py --logging-level WARNING
