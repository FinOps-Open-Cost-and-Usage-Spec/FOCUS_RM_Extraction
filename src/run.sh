#!/bin/sh
# Fixture cycle: runs standalone, no specification checkout needed.
npm run test              # Unit tests, incl. the golden-file extraction test
npm run validate:fixtures # Check the fixture markdown is valid
npm run extract:fixtures  # Extract fixtures into .fixture-output/
npm run verify:fixtures   # Verify that extraction
#
# Against a real specification checkout, pass the folders explicitly:
#   npm run validate -- --specification /path/to/specification
#   npm run extract  -- --specification /path/to/specification --baseline /path/to/releases/latest
#   npm run verify   -- --specification /path/to/specification --baseline /path/to/releases/latest
