#!/bin/bash
set -e

# Only run pnpm install if the lockfile changed in the merge.
# This avoids a 50s+ install on every task merge when dependencies haven't changed.
if git --no-optional-locks diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q 'pnpm-lock\.yaml\|package\.json'; then
  echo "post-merge: lockfile or package.json changed — running pnpm install…"
  pnpm install --frozen-lockfile
else
  echo "post-merge: no lockfile changes — skipping pnpm install"
fi

pnpm --filter db push

# Best-effort install of the python-bridge runtime deps (pefile, unicorn).
# These are required by tools/python-bridge/tools/srtlab_unlock_catalog_gen.py
# and the unlock-catalog-check validation workflow. Gated on python3 being
# present so containers without a python runtime don't fail post-merge, and
# wrapped in `|| true` so a transient pip failure doesn't block unrelated
# tasks from merging — the catalog-check workflow surfaces real install
# problems on its own.
if command -v python3 >/dev/null 2>&1; then
  echo "post-merge: installing python-bridge requirements (best-effort)…"
  python3 -m pip install --user --quiet -r tools/python-bridge/requirements.txt \
    || echo "post-merge: pip install failed; unlock-catalog-check may need manual install"
fi
