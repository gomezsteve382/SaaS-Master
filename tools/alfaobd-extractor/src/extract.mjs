/**
 * AlfaOBD .NET extraction pipeline (orchestrator).
 *
 * Drop `AlfaOBD.exe` (and optionally `shfolder(1).dll`) into
 * `attached_assets/`, then run:
 *
 *   node tools/alfaobd-extractor/extract.mjs \
 *     [--binary <path>] [--shfolder <path>] [--out <dir>] [--decompiler <cmd>]
 *
 * Defaults:
 *   --binary    attached_assets/AlfaOBD.exe
 *   --shfolder  attached_assets/shfolder(1).dll       (optional)
 *   --out       artifacts/srt-lab/public/alfaobd-tables
 *   --decompiler ilspycmd                              (looked up on $PATH)
 *
 * The pipeline refuses to run if AlfaOBD.exe is absent and refuses to
 * run if the decompiler isn't installed. It does NOT scrape the
 * historic chat transcript or invent data.
 *
 * For shfolder(1).dll we deliberately only fingerprint the PE — we do
 * not attempt to bypass Safengine Shielden v2.3.9.0.
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync,
  readdirSync, copyFileSync,
} from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import { OUTPUT_LAYOUT, SCHEMA_VERSION, validate } from "./schema.mjs";
import { fingerprintPE, dotnetMetadata } from "./peFingerprint.mjs";
import { parseDecompiled } from "./parseDecompiled.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR  = resolve(__dirname, "..");
const REPO_ROOT = resolve(TOOL_DIR, "../..");

const TOOL_VERSION = "0.1.0";
const TOOL_NAME    = "@workspace/alfaobd-extractor";

const DEFAULTS = {
  binary:     join(REPO_ROOT, "attached_assets", "AlfaOBD.exe"),
  shfolder:   join(REPO_ROOT, "attached_assets", "shfolder(1).dll"),
  out:        join(REPO_ROOT, "artifacts", "srt-lab", "public", "alfaobd-tables"),
  decompiler: "ilspycmd",
};

const MISSING_BINARY_HELP = `
AlfaOBD.exe was not found.

Drop the binary at:
  attached_assets/AlfaOBD.exe

Then re-run:
  node tools/alfaobd-extractor/extract.mjs

The pipeline does NOT scrape any prior transcript and does NOT invent
data — without the .exe present there is nothing to extract.
`;

const MISSING_DECOMPILER_HELP = (cmd) => `
The .NET decompiler '${cmd}' was not found on PATH.

Install ilspycmd (one-time, requires the .NET 8+ SDK):
  dotnet tool install -g ilspycmd

Or pass another decompiler with: --decompiler <command>
The decompiler must support 'ilspycmd <exe> -o <out_dir>' to produce a
C# project, or '<cmd> --help' must succeed (custom adapters can be
plugged in by setting EXTRACTOR_DECOMPILE_CMD).
`;

export function extract(opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  if (!existsSync(o.binary)) {
    throw new ExtractorError(MISSING_BINARY_HELP, "missing_binary");
  }

  const decompilerInfo = probeDecompiler(o.decompiler);
  if (!decompilerInfo.available) {
    throw new ExtractorError(MISSING_DECOMPILER_HELP(o.decompiler), "missing_decompiler");
  }

  prepareOutputDir(o.out);

  /* 1) PE / .NET fingerprint of AlfaOBD.exe */
  const alfaBuf = readFileSync(o.binary);
  const alfaPe  = fingerprintPE(alfaBuf);
  const alfaNet = dotnetMetadata(alfaPe);
  if (!alfaNet.is_dotnet) {
    throw new ExtractorError(
      `Refusing to proceed: ${o.binary} does not look like a managed .NET PE ` +
      `(no COR20 directory). Refusing to invent decompilation results.`,
      "not_dotnet");
  }

  /* 2) Decompile AlfaOBD.exe to a C# project */
  const decompileDir = mktempDir("alfaobd-decompile-");
  try {
    runDecompile(o.decompiler, o.binary, decompileDir);

    /* 3) Walk the decompiled C# files for ECUTYPE_*, Process*Data,
     *    and transport types. */
    const filesByPath = readDecompiledTree(decompileDir);
    const { ecutypeFamilies, handlers, transports } =
      parseDecompiled(filesByPath);

    /* 4) Emit JSON outputs. */
    const writtenFiles = [];

    /* 4a) ECUTYPE_* — one file per family. */
    const ecutypesDir = join(o.out, OUTPUT_LAYOUT.ecutypesDir);
    mkdirSync(ecutypesDir, { recursive: true });
    let totalModules = 0;
    for (const fam of ecutypeFamilies) {
      const payload = {
        schema_version: SCHEMA_VERSION,
        family: fam.family,
        modules: fam.modules,
      };
      const errors = validate("ecutypeFamily", payload, "ecutypeFamily");
      if (errors.length) {
        throw new ExtractorError(
          `Schema violation in ecutype family '${fam.family}':\n  ${errors.join("\n  ")}`,
          "schema_failed");
      }
      const path = join(ecutypesDir, `${fam.family}.json`);
      writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
      writtenFiles.push(fileEntry(o.out, path));
      totalModules += fam.modules.length;
    }

    /* 4b) Handlers. */
    const handlersPayload = { schema_version: SCHEMA_VERSION, handlers };
    assertSchema("handlers", handlersPayload);
    writeJSON(o.out, OUTPUT_LAYOUT.handlers, handlersPayload, writtenFiles);

    /* 4c) Transports. */
    const transportsPayload = { schema_version: SCHEMA_VERSION, transports };
    assertSchema("transports", transportsPayload);
    writeJSON(o.out, OUTPUT_LAYOUT.transports, transportsPayload, writtenFiles);

    /* 4d) Resources & embedded media. */
    const { bundles, media } =
      collectResources(decompileDir, join(o.out, OUTPUT_LAYOUT.mediaDir));
    const resourcesPayload = {
      schema_version: SCHEMA_VERSION,
      bundles,
      media,
    };
    assertSchema("resources", resourcesPayload);
    writeJSON(o.out, OUTPUT_LAYOUT.resources, resourcesPayload, writtenFiles);
    for (const m of media) {
      writtenFiles.push(fileEntry(o.out, join(o.out, OUTPUT_LAYOUT.mediaDir, m.file)));
    }

    /* 5) shfolder(1).dll fingerprint (PE-only, no unpacking). */
    const shFingerprint = fingerprintShfolder(o.shfolder);

    /* 6) Manifest. */
    const manifestPayload = {
      schema_version: SCHEMA_VERSION,
      tool: {
        name: TOOL_NAME,
        version: TOOL_VERSION,
        decompiler: {
          name: o.decompiler,
          version_command: `${o.decompiler} --version`,
          version_output: decompilerInfo.versionOutput,
        },
      },
      generated_at: new Date().toISOString(),
      alfaobd: {
        sha256: sha256(alfaBuf),
        size_bytes: alfaBuf.length,
        file_version: extractAssemblyVersion(filesByPath) || (alfaNet.clr_version || "unknown"),
        assembly_name: extractAssemblyName(filesByPath) || "AlfaOBD",
        is_dotnet: true,
        clr_version: alfaNet.clr_version,
        pe_machine:    alfaPe.machine,
        pe_timestamp:  alfaPe.pe_timestamp,
      },
      shfolder: shFingerprint,
      inputs: {
        alfaobd_path:  relative(REPO_ROOT, o.binary),
        shfolder_path: existsSync(o.shfolder) ? relative(REPO_ROOT, o.shfolder) : "(missing)",
      },
      outputs: { files: writtenFiles },
      counts: {
        ecutype_families: ecutypeFamilies.length,
        ecutype_modules:  totalModules,
        handlers:         handlers.length,
        transports:       transports.length,
        resources:        bundles.length,
        media_files:      media.length,
      },
    };
    assertSchema("manifest", manifestPayload);
    writeJSON(o.out, OUTPUT_LAYOUT.manifest, manifestPayload, writtenFiles);

    return manifestPayload;
  } finally {
    rmSync(decompileDir, { recursive: true, force: true });
  }
}

/* ── Helpers ───────────────────────────────────────────────────────── */
class ExtractorError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function probeDecompiler(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  if (r.error || (r.status !== 0 && !r.stdout && !r.stderr)) {
    return { available: false };
  }
  return { available: true, versionOutput: (r.stdout || r.stderr || "").trim().slice(0, 200) };
}

function runDecompile(cmd, exe, outDir) {
  /* ilspycmd convention: ilspycmd <input.exe> -p -o <out_dir>
   * The -p flag emits a project (one .cs per managed type), which is
   * what we walk in step 3. Adapters for other decompilers can set
   * EXTRACTOR_DECOMPILE_CMD to a custom command template using
   * {{INPUT}} and {{OUT}} placeholders. */
  const tmpl = process.env.EXTRACTOR_DECOMPILE_CMD;
  let argv;
  if (tmpl) {
    argv = tmpl.split(/\s+/).map(a =>
      a.replace("{{INPUT}}", exe).replace("{{OUT}}", outDir));
  } else {
    argv = ["-p", "-o", outDir, exe];
  }
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new ExtractorError(
      `Decompiler '${cmd} ${argv.join(" ")}' failed (status ${r.status}):\n${r.stderr || r.stdout || ""}`,
      "decompile_failed");
  }
}

function readDecompiledTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".cs")) {
        out.set(relative(dir, p), readFileSync(p, "utf8"));
      }
    }
  };
  walk(dir);
  return out;
}

function collectResources(decompileDir, mediaOutDir) {
  /* ilspycmd writes managed resources next to the decompiled types.
   * A resource bundle named `Foo.Bar.resources` lands as a directory
   * tree like `Foo/Bar.resources/<entry-name>` with each entry as its
   * own file. We surface the bundle list and copy any image-like
   * entries (PNG/GIF/JPEG) into the output media dir, preserving the
   * logical resource name. */
  const bundles = new Map(); // bundle name -> entry count
  const media = [];

  const isImageMime = (b) => {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
    return null;
  };

  const walk = (d, parts = []) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      const st = statSync(p);
      const nextParts = [...parts, name];
      if (st.isDirectory()) {
        if (name.endsWith(".resources")) {
          const bundleName = nextParts.join(".");
          bundles.set(bundleName, 0);
          walkBundle(p, bundleName);
        } else {
          walk(p, nextParts);
        }
      }
    }
  };

  const walkBundle = (d, bundleName) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walkBundle(p, bundleName); continue; }
      bundles.set(bundleName, (bundles.get(bundleName) || 0) + 1);
      const buf = readFileSync(p);
      const mime = isImageMime(buf);
      if (!mime) continue;
      const ext = mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : "jpg";
      const safe = bundleName.replace(/[^A-Za-z0-9_.-]+/g, "_") + "__" +
                   name.replace(/[^A-Za-z0-9_.-]+/g, "_");
      const outName = safe.endsWith(`.${ext}`) ? safe : `${safe}.${ext}`;
      mkdirSync(mediaOutDir, { recursive: true });
      writeFileSync(join(mediaOutDir, outName), buf);
      media.push({
        name,
        file: outName,
        mime,
        size_bytes: buf.length,
        sha256: sha256(buf),
      });
    }
  };

  walk(decompileDir);

  const bundleList = Array.from(bundles.entries())
    .map(([name, entry_count]) => ({ name, entry_count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  media.sort((a, b) => a.file.localeCompare(b.file));
  return { bundles: bundleList, media };
}

function fingerprintShfolder(path) {
  if (!existsSync(path)) {
    return {
      sha256: null,
      size_bytes: 0,
      protected_skip: true,
      protector: "(file not present)",
      exports: [],
      imports: [],
    };
  }
  const buf = readFileSync(path);
  const pe  = fingerprintPE(buf);
  const protector = detectProtector(buf, pe);
  return {
    sha256: sha256(buf),
    size_bytes: buf.length,
    protected_skip: true,
    protector,
    exports: pe.exports,
    imports: pe.imports.sort(),
    sections: pe.sections.map(s => ({ name: s.name, entropy: s.entropy })),
  };
}

function detectProtector(buf, pe) {
  /* Static signature scan only — never executes the DLL. */
  const text = bufferAscii(buf);
  if (/Safengine\s+Shielden\s+v?[0-9.]+/.test(text)) {
    const m = text.match(/Safengine\s+Shielden\s+v?([0-9.]+)/);
    return `Safengine Shielden v${m ? m[1] : "unknown"}`;
  }
  if (text.includes("SESDKDummy64") || text.includes("SECheckLicense") || text.includes("SEGetLicenseHash")) {
    return "Safengine Shielden (version unknown)";
  }
  if (text.includes("UPX!")) return "UPX (unrelated)";
  if (pe.sections.some(s => s.entropy > 7.8 && s.name.startsWith(".se"))) {
    return "Safengine Shielden (heuristic; high-entropy .se* sections)";
  }
  return "(unknown / unprotected)";
}

function bufferAscii(buf) {
  let s = "";
  const max = Math.min(buf.length, 8 * 1024 * 1024);
  for (let i = 0; i < max; i++) {
    const b = buf[i];
    s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : " ";
  }
  return s;
}

function extractAssemblyName(filesByPath) {
  for (const [, text] of filesByPath) {
    const m = text.match(/\[assembly:\s*AssemblyTitle\("([^"]+)"\)\]/);
    if (m) return m[1];
  }
  return null;
}
function extractAssemblyVersion(filesByPath) {
  for (const [, text] of filesByPath) {
    const m = text.match(/\[assembly:\s*AssemblyFileVersion\("([^"]+)"\)\]/) ||
              text.match(/\[assembly:\s*AssemblyVersion\("([^"]+)"\)\]/);
    if (m) return m[1];
  }
  return null;
}

function prepareOutputDir(dir) {
  /* Wipe known artifacts so a stale entry from a previous build can
   * never silently survive. We only remove files we own (the schema
   * lists them) — we never blow away the whole directory in case the
   * user has put unrelated files there. */
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); return; }
  for (const name of [OUTPUT_LAYOUT.manifest, OUTPUT_LAYOUT.handlers,
                      OUTPUT_LAYOUT.transports, OUTPUT_LAYOUT.resources]) {
    rmSync(join(dir, name), { force: true });
  }
  rmSync(join(dir, OUTPUT_LAYOUT.ecutypesDir), { recursive: true, force: true });
  rmSync(join(dir, OUTPUT_LAYOUT.mediaDir),    { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function writeJSON(outDir, name, payload, writtenFiles) {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  if (writtenFiles) writtenFiles.push(fileEntry(outDir, path));
}

function assertSchema(kind, payload) {
  const errors = validate(kind, payload, kind);
  if (errors.length) {
    throw new ExtractorError(
      `Schema violation in '${kind}':\n  ${errors.join("\n  ")}`,
      "schema_failed");
  }
}

function fileEntry(outDir, absPath) {
  const buf = readFileSync(absPath);
  return {
    path: relative(outDir, absPath).split("\\").join("/"),
    sha256: sha256(buf),
    bytes: buf.length,
  };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function mktempDir(prefix) {
  const p = join(tmpdir(), prefix + Math.random().toString(36).slice(2, 10));
  mkdirSync(p, { recursive: true });
  return p;
}

export { ExtractorError };
