# attached_assets — provenance notes

## Renamed / removed drops

- **`tsetup-x64.6.7.5_1776900458954.exe`** (removed, Task #496) — was not an
  executable; the file was a 33 KB UTF-8 React JSX component implementing
  the FCA Module Inspector (`MODULE_TYPES` / `detectModuleType` /
  `scanForVINs` / `SKIM_VALUES`). The misnamed `.exe` suffix had silently
  stranded it. The component was rehomed verbatim to
  `artifacts/srt-lab/src/tabs/FcaModuleInspector.jsx` and wired into the
  SRT Lab workspace as the **MODULE INSPECTOR** tab.
