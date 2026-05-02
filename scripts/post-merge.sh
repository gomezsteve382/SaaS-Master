#!/bin/bash
set -e
pnpm install --frozen-lockfile
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
