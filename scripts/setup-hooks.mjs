#!/usr/bin/env node
// Installer for the srt-lab realDumps fixture pre-commit hook.
//
// Symlinks (or copies) artifacts/srt-lab/scripts/fixtures-precommit.sh
// into .git/hooks/pre-commit so the local guardrail (Task #451) becomes
// the default for everyone instead of an opt-in maintainers have to
// remember from a README snippet.
//
// Usage
// -----
//   pnpm setup-hooks            install (refuses to clobber a foreign hook)
//   pnpm setup-hooks --force    overwrite whatever is there (stashes a .bak)
//   pnpm setup-hooks --copy     copy instead of symlink (Windows / no-symlink FS)
//   pnpm setup-hooks --check    exit 0 if managed hook is in place, else non-zero
//
// CI safety
// ---------
// Skips itself silently when CI=1 or REPLIT_SETUP_HOOKS_SKIP=1 is set, so
// build environments and isolated agents never self-modify their local
// .git/hooks. To force-install in those environments, pass --force.

import { existsSync, lstatSync, mkdirSync, readlinkSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const HELPER_REL = "artifacts/srt-lab/scripts/fixtures-precommit.sh";
const HELPER_ABS = join(REPO_ROOT, HELPER_REL);
const HOOK_REL = ".git/hooks/pre-commit";
const HOOK_ABS = join(REPO_ROOT, HOOK_REL);

// Marker line so we can recognize a hook this installer wrote (when
// --copy was used, or when an older managed install was a wrapper
// instead of a symlink).
const MANAGED_MARKER = "# managed-by: scripts/setup-hooks.mjs (srt-lab fixtures pre-commit)";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const COPY = args.has("--copy");
const CHECK = args.has("--check");

function log(msg) {
  process.stdout.write(`[setup-hooks] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[setup-hooks] ${msg}\n`);
}

function isManagedHook() {
  if (!existsSync(HOOK_ABS)) return false;
  const stat = lstatSync(HOOK_ABS);
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(HOOK_ABS);
    } catch {
      return false;
    }
    // Resolve relative-to-hook-dir, normalize, compare against the
    // helper's absolute path.
    const resolved = resolve(dirname(HOOK_ABS), target);
    return resolved === HELPER_ABS;
  }
  // Plain file: managed iff it carries our marker line.
  try {
    const body = readFileSync(HOOK_ABS, "utf8");
    return body.includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

function ensureGitRepo() {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    if (resolve(top) !== REPO_ROOT) {
      warn(`git toplevel (${top}) does not match repo root (${REPO_ROOT}); refusing to install.`);
      process.exit(1);
    }
  } catch {
    warn("not inside a git checkout; nothing to install.");
    process.exit(CHECK ? 1 : 0);
  }
}

function ensureHelperPresent() {
  if (!existsSync(HELPER_ABS)) {
    warn(`helper not found at ${HELPER_REL}; cannot install.`);
    process.exit(1);
  }
}

function ensureHooksDir() {
  const hooksDir = dirname(HOOK_ABS);
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
}

function backupExisting() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${HOOK_ABS}.bak.${stamp}`;
  renameSync(HOOK_ABS, backup);
  log(`existing pre-commit hook moved aside to ${relative(REPO_ROOT, backup)}`);
}

function writeWrapperCopy() {
  const wrapper = `#!/bin/sh
${MANAGED_MARKER}
# Wrapper installed by 'pnpm setup-hooks --copy'. Edits to
# ${HELPER_REL} require re-running the installer to pick them up.
# Prefer the symlink install (drop --copy) if your filesystem supports it.
exec sh "$(git rev-parse --show-toplevel)/${HELPER_REL}" "$@"
`;
  writeFileSync(HOOK_ABS, wrapper, { mode: 0o755 });
  chmodSync(HOOK_ABS, 0o755);
}

function installSymlink() {
  // Symlink target is relative to the hook file's directory so the
  // checkout is portable (.git/hooks/ → ../../artifacts/...).
  const target = relative(dirname(HOOK_ABS), HELPER_ABS);
  symlinkSync(target, HOOK_ABS);
}

function install() {
  ensureGitRepo();
  ensureHelperPresent();
  ensureHooksDir();

  if (existsSync(HOOK_ABS)) {
    if (isManagedHook()) {
      // Re-installing on top of our own managed hook is fine — refresh it
      // (cheap, idempotent) so a switch between symlink/copy mode works.
      unlinkSync(HOOK_ABS);
    } else if (FORCE) {
      backupExisting();
    } else {
      warn(`refusing to overwrite existing pre-commit hook at ${HOOK_REL}.`);
      warn("If it's a custom hook (husky, lefthook, hand-rolled, ...), invoke");
      warn("the helper from inside it instead — add this line:");
      warn("");
      warn(`  sh "$(git rev-parse --show-toplevel)/${HELPER_REL}" || exit 1`);
      warn("");
      warn("Or, to replace it with the managed install (a backup is kept):");
      warn("  pnpm setup-hooks --force");
      process.exit(1);
    }
  }

  if (COPY) {
    writeWrapperCopy();
    log(`installed managed wrapper at ${HOOK_REL} (copy mode).`);
    log(`-> delegates to ${HELPER_REL}`);
  } else {
    try {
      installSymlink();
    } catch (err) {
      warn(`symlink failed (${err && err.code ? err.code : err}); falling back to copy mode.`);
      writeWrapperCopy();
      log(`installed managed wrapper at ${HOOK_REL} (copy mode).`);
      log(`-> delegates to ${HELPER_REL}`);
      return;
    }
    // Make sure the helper itself is executable (the hook invokes it
    // directly via the symlink, so it needs +x).
    try {
      chmodSync(HELPER_ABS, 0o755);
    } catch {
      /* best-effort; not fatal on filesystems that ignore the bit */
    }
    log(`installed symlink at ${HOOK_REL}`);
    log(`-> ${HELPER_REL}`);
  }
  log("done. Future commits that touch artifacts/srt-lab/src/lib/__fixtures__/realDumps/");
  log("will automatically run 'pnpm fixtures:check' before the commit lands.");
}

function check() {
  ensureGitRepo();
  if (isManagedHook()) {
    log(`managed pre-commit hook is installed at ${HOOK_REL}.`);
    process.exit(0);
  }
  if (existsSync(HOOK_ABS)) {
    warn(`pre-commit hook at ${HOOK_REL} is NOT the managed installer.`);
    warn("Run 'pnpm setup-hooks' to install, or invoke the helper from your");
    warn(`existing hook: sh "$(git rev-parse --show-toplevel)/${HELPER_REL}" || exit 1`);
  } else {
    warn(`no pre-commit hook installed at ${HOOK_REL}.`);
    warn("Run 'pnpm setup-hooks' to install the realDumps fixture guardrail.");
  }
  process.exit(1);
}

if (CHECK) {
  check();
} else {
  // CI / isolated-agent safety: don't self-modify .git/hooks unless
  // the caller explicitly opted in with --force.
  if (!FORCE && (process.env.CI === "1" || process.env.CI === "true" || process.env.REPLIT_SETUP_HOOKS_SKIP === "1")) {
    log("CI / REPLIT_SETUP_HOOKS_SKIP detected; skipping hook install (pass --force to override).");
    process.exit(0);
  }
  install();
}
