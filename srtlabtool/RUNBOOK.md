# CDA Extraction Runbook

This workspace is set up to extract and analyze `CDA.swf` losslessly, then produce clone-ready artifacts.

## 1) Full Extraction

```powershell
node .\extract-cda-swf.mjs --input "C:\Users\gomez\Desktop\CDA.swf" --out "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted"
```

## 2) Analysis Reports

```powershell
node .\build-cda-audit.mjs
node .\extract-abc-symbols.mjs
node .\analyze-avm2-abc.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --abc "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted\assets\doabc\tag_0006_frame1.abc" --out-prefix frame1_ --emit-bytecode-lines
node .\analyze-avm2-abc.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --abc "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted\assets\doabc\tag_0367_frame2.abc" --out-prefix frame2_ --emit-bytecode-lines
node .\build-avm2-domain-map.mjs
node .\build-buslog-rebuild-pack.mjs
```

## 3) Clone Workspace Build

```powershell
node .\build-cda-clone-workspace.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted"
node .\build-uds-rebuild-pack.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted"
```

## 4) Package Artifacts

```powershell
Compress-Archive -Path .\cda_extracted\clone_workspace\* -DestinationPath .\cda_clone_workspace.zip -Force
Compress-Archive -Path .\cda_extracted\* -DestinationPath .\cda_extracted_full_everything.zip -Force
```

## 5) Integrity References

- `cda_extracted\manifest\summary.json`
- `cda_extracted\manifest\tags.jsonl`
- `cda_extracted\manifest\artifacts.jsonl`
- `cda_extracted\clone_workspace\manifest\clone_summary.json`

## 6) Verification

Run deterministic reproducibility checks (hard-fail on any drift):

```powershell
node .\verify-cda-repro.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted"
```

Machine-readable output:

```powershell
node .\verify-cda-repro.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --json
```

Write verification report file:

```powershell
node .\verify-cda-repro.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --json --out ".\verify-cda-report.json"
```

Exit codes:

- `0` = all checks passed
- `1` = at least one blocking check failed

Run full verifier suite (baseline + tamper-fail scenarios with automatic restore):

```powershell
node .\run-cda-verifier-suite.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --json
```

Record a provenance snapshot (hash-linked verification record):

```powershell
node .\record-cda-verify-snapshot.mjs --root "C:\Users\gomez\Documents\Codex\2026-05-20\files-mentioned-by-the-user-srt\cda_extracted" --out-dir ".\verification_history" --json
```

## 7) Git / LFS Notes

- This repo tracks heavy binaries with Git LFS (`.zip`, `.swf`, `.bin`, `.abc`, `.zlib`, `.raw`, `.jpg`).
- Push with:

```powershell
git push origin main
```
