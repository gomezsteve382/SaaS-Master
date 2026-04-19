# scripts/

Build-time helpers for the SRT Lab repo. Most are one-shot; none of them are
called from the dev server.

---

## `build-flyer.mjs` — regenerate the SRT Lab flyer

Renders `attached_assets/flyers/srt_lab_flyer.{svg,png,pdf}` from the inline
SVG template at the top of the script. Edit the `blocks` / `hero` / `footer`
sections in `build-flyer.mjs`, then re-run the script.

### Prerequisites

The Replit Nix environment already provides everything below, so on a fresh
checkout you should not need to install anything — just run the command.
This section exists so that if a future image rebuild drops one of these,
you know what to look for.

1. **ImageMagick** (`magick` on PATH).
   - Used only to discover the path to `rsvg-convert` from its delegate
     registry (`magick -list delegate`). The actual rendering is done by
     librsvg, not IM.
2. **librsvg** (`rsvg-convert` on PATH, or registered as IM's `svg =>` delegate).
   - Does the real PNG + PDF render. Must be a recent build (≥ 2.55) so that
     `--dpi-x` / `--dpi-y` produce a Letter-sized PDF page.
3. **Node.js 24** (already pinned by the monorepo).

Verify in one shot:

```bash
which magick rsvg-convert
magick -list delegate | grep '^ *svg'
node --version
```

### Fonts

The flyer references three brand fonts:

| Family            | Used for                        |
| ----------------- | ------------------------------- |
| `Righteous`       | Display / wordmark / tile titles |
| `Nunito`          | Body copy and bullets           |
| `JetBrains Mono`  | Eyebrows, chips, footer mono    |

**If those fonts are not registered with fontconfig, librsvg silently falls
back to DejaVu.** The render still succeeds — there is no "font not found"
error — but the result looks generic and the hero wordmark loses its
Righteous character. So: missing fonts ≠ broken build, but you almost
certainly want them installed before publishing a new flyer.

One-time install (Google Fonts, into the user font dir):

```bash
mkdir -p ~/.fonts && cd ~/.fonts

# Righteous
curl -sSL -o Righteous.ttf \
  "https://github.com/google/fonts/raw/main/ofl/righteous/Righteous-Regular.ttf"

# Nunito (regular + bold + black so font-weight 500/700/900 all resolve)
for w in Regular Medium SemiBold Bold ExtraBold Black; do
  curl -sSL -o "Nunito-${w}.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/nunito/static/Nunito-${w}.ttf"
done

# JetBrains Mono (regular + bold)
for w in Regular Bold; do
  curl -sSL -o "JetBrainsMono-${w}.ttf" \
    "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-${w}.ttf"
done

fc-cache -f ~/.fonts
fc-list | grep -iE 'righteous|nunito|jetbrains'   # sanity check
```

### Regenerate

From the repo root:

```bash
node scripts/build-flyer.mjs
```

Expected output:

```
wrote .../attached_assets/flyers/srt_lab_flyer.svg <bytes> bytes
using /nix/store/.../bin/rsvg-convert
wrote .../attached_assets/flyers/srt_lab_flyer.png
wrote .../attached_assets/flyers/srt_lab_flyer.pdf
```

The PDF is exactly US Letter (8.5 × 11 in / 612 × 792 pt) because the SVG is
authored at 2550 × 3300 px and rendered at 300 dpi.

### Troubleshooting

- **`Error reading SVG`** — librsvg can't find or can't parse the intermediate
  SVG. Re-run; if it persists, open `attached_assets/flyers/srt_lab_flyer.svg`
  in a browser to see what choked.
- **Wordmark looks like Times / DejaVu** — `Righteous` is not in fontconfig.
  Install per the Fonts section above and re-run.
- **`magick: command not found`** — ImageMagick isn't on PATH. On Replit it
  comes from the system Nix profile; if missing, `pkgs.imagemagick` and
  `pkgs.librsvg` are the relevant Nix packages.
- **PDF page is huge (11.3 × 14.6 in)** — librsvg defaulted to 96 dpi.
  Confirm your `rsvg-convert` accepts `--dpi-x 300 --dpi-y 300` (older builds
  silently ignore it).

---

## `artifacts/srt-lab/scripts/extract-alfaobd.mjs` — AlfaOBD database codegen

Extracts an English-only slice of the reverse-engineered AlfaOBD SQLite
database into `artifacts/srt-lab/src/lib/alfaobdData.generated.js`. Wired
into the SRT Lab `prebuild` / `predev` hooks; also runnable directly:

```bash
pnpm --filter @workspace/srt-lab codegen:alfaobd        # write
pnpm --filter @workspace/srt-lab codegen:alfaobd:check  # CI: in-sync check
```

### Source data (in `attached_assets/`)

- `alfao_bd*.decrypted*.db` — the 66 MB XOR-decrypted SQLite dump from
  `AlfaOBD.exe`. **Treat as build-time input only — never bundle it.**
- `alfao_bd*.xor_key*.bin` / `*.xor_key.hex*.txt` — the 1024-byte XOR key
  recovered statistically from the encrypted original. Kept for posterity.
- `alfao_bd*.analysis*.txt` — partial schema dump (CREATE statements
  truncated by the same corruption that affects the data).
- `decrypt_alfaobd*.py` — the helper used to produce the decrypted .db.

### Known data corruption (read this before re-running)

The decrypted .db has too many byte errors for SQLite to traverse its
B-tree (sqlite_master itself is unreadable). The script works around this
by running `sqlite3 .recover` on the source, caching the recovered DB at
`attached_assets/.cache/alfao_bd.recovered.db` (gitignored), then
bucketing rows by their original column count. Recovery takes ~30s on
the first run; subsequent runs reuse the cache as long as the source is
unchanged.

Tables that survive the recovery cleanly:

- **`DIAG_NAMES`** (~3,800 rows): parameter-id → English label.
- **`CGW_CONFIG`** (~430 rows): byte/bit feature matrix entries with
  `{ byte, bit, length, name, options[] }` for the BCM/CGW config
  decoder (Task #144).

Tables that **do NOT** survive (text columns are mojibake; 0 rows pass
a basic ASCII filter):

- `Faults` (DTC plain-English text)
- `STATES` (state-id → label)
- `Units` (unit-id → string)
- `Diag_descriptions`

These are exported as empty stubs so consumers fail loudly instead of
silently. Task #143 (DTC plain-English overlay) is blocked until a
clean .db (or a corrected XOR key) is provided; re-run the codegen
after dropping the new file in `attached_assets/`.

### Prerequisites

- `sqlite3` CLI on PATH (provided by the `sqlite` Nix package).
- `better-sqlite3` (devDep of `@workspace/srt-lab`, native build).

---

## `build-codebase-bundle.mjs` — Codebase packager

Produces two offsite-friendly snapshots of the monorepo at the repo root:

- `srt-lab-monorepo.tar.gz` — full archive of every git-tracked file (minus
  large generated DBs `*.db` / `*.sqlite*`, `.env*`, OS junk, and the bundle
  outputs themselves). Verified by extracting and counting files.
- `srt-lab-monorepo-bundle.txt` — single text file with every text source
  inlined in full and binaries replaced by `<<binary file, NNN bytes,
  sha256:…>>` placeholders. Useful for context-paste / LLM ingestion.

Inventory comes from `git ls-files`, so `.gitignore` is honored automatically
(no `node_modules`, `.cache`, `dist`, `.local`, etc.).

### Regenerate

From the repo root:

```bash
pnpm bundle
```

That's wired in `package.json` (`scripts.bundle`) and is the one command
anyone needs to refresh both files. Output paths are printed at the end of
the run.

### Prerequisites

- `git` on PATH (for `git ls-files`).
- `tar` on PATH (gzip mode). Both ship in the default Replit Nix profile.

## Other scripts

- `build-codebase-bundle.mjs` — packages the monorepo for offsite hand-off.
  Always writes the text bundle (`srt-lab-monorepo-bundle.txt`, ~6 MB, with
  binaries as sha256 placeholders). Pick which tarball(s) you want with
  `--mode`:

  ```bash
  node scripts/build-codebase-bundle.mjs                # both (default)
  node scripts/build-codebase-bundle.mjs --mode=code    # ~0.6 MB, source only
  node scripts/build-codebase-bundle.mjs --mode=full    # ~141 MB, includes attached_assets/
  ```

  - `srt-lab-monorepo-code.tar.gz` — source tree minus `attached_assets/`.
    The right pick when you just want the code.
  - `srt-lab-monorepo.tar.gz` — everything, including the BCM/RFH .bin
    dumps, AlfaOBD .db / .zip, screenshots, etc. Needed for re-running
    AlfaOBD codegen, the seed-key catalog, and any task that pattern-matches
    against the captured ECU binaries.

  When invoked with a single mode, the other archive is removed so a stale
  copy doesn't sit next to the fresh one.
- `post-merge.sh` — runs after a task merge (managed by Replit, do not invoke
  manually).

---

## `artifacts/srt-lab/scripts/extract-alfaobd-algorithms.mjs` — AlfaOBD seed-key catalog codegen

Reads `attached_assets/alfaobd_algorithm_catalog*.json` and emits
`artifacts/srt-lab/src/lib/alfaobdAlgorithms.generated.js` exporting:

- `AOBD_W6` — 380 per-ECU `(r, s)` constant pairs for the parameterized
  linear cipher (`alfaW6` in `algos.js`). Drives the SeedTab "AlfaOBD
  lookup" affordance and the `alfa_w6_*` registry entries.
- `AOBD_W7` — 360 per-ECU `(n, o, p)` triples. **Data only.** The
  arithmetic core (`ad::w7` plus 7 big-integer helpers) has not yet been
  translated; SeedTab surfaces these rows in a read-only "algorithm
  pending translation" panel so the catalog is visibly staged.
- `AOBD_DISPATCH` — `{ family|ecu: { level: wrapperName } }` for the 8
  ECU families resolved by AlfaOBD's `abf()` switch plus 2 explicit
  per-ECU branches (UCONNECT, RADIO_FGA at level 5).

Wired into `prebuild` / `predev` next to the AlfaOBD database codegen.
Also runnable directly:

```bash
pnpm --filter @workspace/srt-lab codegen:alfaobd-algos        # write
pnpm --filter @workspace/srt-lab codegen:alfaobd-algos:check  # CI: in-sync
```

### Source data (in `attached_assets/`)

- `alfaobd_algorithm_catalog*.json` — the machine-readable bundle (3378
  lines) carrying all 740 wrappers + dispatch map. Source of truth — do
  not hand-copy `(r, s)` or `(n, o, p)` values into source.
- `alfaobd_seedkey_*.{js,py}` — reference impls for `ht`, `f`, `ao`
  used to generate the pinned vectors in
  `src/__tests__/algos.alfaobd.test.mjs`.
- `alfaobd_seedkey_README_*.md` — RE notes on the algorithms.
