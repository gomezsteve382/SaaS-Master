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

## Other scripts

- `bundle-all-code.mjs` — concatenates the React app's source into a single
  text bundle for sharing / context-paste use.
- `post-merge.sh` — runs after a task merge (managed by Replit, do not invoke
  manually).
