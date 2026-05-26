#!/usr/bin/env bash
# End-to-end DB persistence smoke for srt-lab-ultimate.
#
# Confirms that the Postgres-backed API actually persists analyses:
#   1. GET /api/vault   — clean DB read (no SQL error)
#   2. POST /api/upload — runs the analyzer and writes an analysis row
#   3. GET /api/vault   — the new row is visible
#   4. GET /api/analysis/:id — full record fetch round-trips
#
# Requires: the `artifacts/srt-lab-ultimate: api` workflow running and
# DATABASE_URL pointing at a Postgres database that has the schema from
# drizzle/migrations/0000_*.sql applied.
#
# Usage:  bash artifacts/srt-lab-ultimate/smoke-tests/db-persistence.sh
set -euo pipefail

BASE="${SRTLABU_BASE:-http://localhost:80/srtlabu/api}"
TMP_BIN="$(mktemp --suffix=.bin)"
trap 'rm -f "$TMP_BIN"' EXIT

printf 'SMOKEBINARY%.0s' {1..64} > "$TMP_BIN"

echo "[1/4] GET $BASE/vault (baseline read)"
curl -fsS "$BASE/vault" >/dev/null
echo "      ok"

echo "[2/4] POST $BASE/upload (write through analyzer)"
RESP="$(curl -fsS -X POST -F "file=@${TMP_BIN}" "$BASE/upload")"
ID="$(printf '%s' "$RESP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)"
if [ -z "$ID" ]; then
  echo "      FAIL: no id returned" >&2
  printf '%s\n' "$RESP" >&2
  exit 1
fi
echo "      created analysis id=$ID"

echo "[3/4] GET $BASE/vault (row visible)"
curl -fsS "$BASE/vault" | grep -q "\"$ID\"" || {
  echo "      FAIL: id $ID not in vault listing" >&2
  exit 1
}
echo "      ok"

echo "[4/4] GET $BASE/analysis/$ID (record round-trips)"
curl -fsS "$BASE/analysis/$ID" | grep -q "\"$ID\"" || {
  echo "      FAIL: analysis $ID not fetchable" >&2
  exit 1
}
echo "      ok"

echo "PASS: srt-lab-ultimate DB persistence end-to-end"
