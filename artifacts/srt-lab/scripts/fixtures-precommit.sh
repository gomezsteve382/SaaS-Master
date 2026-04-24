#!/bin/sh
# Pre-commit / pre-push hook helper for srt-lab realDumps fixtures.
#
# When any file under
#   artifacts/srt-lab/src/lib/__fixtures__/realDumps/
# is staged for commit, this script runs the four realDumps regression
# suites:
#   - anonymizeRealDump.test.js
#   - realDumps.anonymization.test.js
#   - realDumps.helperLeakScan.test.js
#   - securityBytes.realDump.golden.test.js
#
# These are the same suites CI runs on every push (Task #448 added the
# byte-for-byte round-trip pin). Wiring them into a local hook surfaces
# a bad fixture edit the same minute it happens, instead of 10 minutes
# later in CI.
#
# When no realDumps file is staged the script exits 0 silently — no-op
# overhead on commits that don't touch fixtures.
#
# Usage
# -----
# One-shot, on demand:
#   pnpm --filter @workspace/srt-lab fixtures:check       # always runs the suites
#   pnpm --filter @workspace/srt-lab fixtures:precommit   # runs only if fixtures are staged
#
# Wire into git pre-commit (run from repo root):
#   ln -sf ../../artifacts/srt-lab/scripts/fixtures-precommit.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or invoke from an existing pre-commit hook:
#   sh artifacts/srt-lab/scripts/fixtures-precommit.sh || exit 1

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  # Not in a git checkout — nothing to scan, treat as no-op.
  exit 0
fi

# --diff-filter=ACMRT covers Added/Copied/Modified/Renamed/TypeChanged.
# We deliberately ignore Deleted: a deletion of a fixture won't make the
# remaining fixtures fail their round-trip pin.
STAGED_FIXTURES="$(git -C "$REPO_ROOT" diff --cached --name-only --diff-filter=ACMRT 2>/dev/null \
  | grep -E '^artifacts/srt-lab/src/lib/__fixtures__/realDumps/' || true)"

if [ -z "$STAGED_FIXTURES" ]; then
  exit 0
fi

echo "[srt-lab] realDumps fixture change detected; running fixtures:check..."
echo "$STAGED_FIXTURES" | sed 's/^/  - /'

cd "$REPO_ROOT"
pnpm --filter @workspace/srt-lab run fixtures:check
