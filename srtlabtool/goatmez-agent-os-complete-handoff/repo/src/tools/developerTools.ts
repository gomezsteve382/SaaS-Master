import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ToolDefinition } from "../core/types.js";

const ignoredDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".goatmez", "coverage", "__pycache__"]);
const textExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".css", ".html", ".py", ".yml", ".yaml", ".env", ".example", ".toml", ".ini", ".sql"
]);

function assertInsideWorkspace(path: string, cwd: string): string {
  const full = resolve(cwd, path);
  const root = resolve(cwd);
  if (!full.startsWith(root)) throw new Error("Path escapes the approved workspace root.");
  return full;
}

async function walk(root: string, current: string, maxFiles: number, maxDepth: number, depth = 0, out: string[] = []): Promise<string[]> {
  if (out.length >= maxFiles || depth > maxDepth) return out;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = join(current, entry.name);
    const rel = relative(root, full) || ".";
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      await walk(root, full, maxFiles, maxDepth, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function detectStack(files: string[], packageJson?: any): string[] {
  const stack = new Set<string>();
  if (files.some((file) => file === "package.json")) stack.add("node");
  if (files.some((file) => file === "tsconfig.json")) stack.add("typescript");
  if (files.some((file) => file.includes("next.config"))) stack.add("nextjs");
  if (files.some((file) => file.endsWith("requirements.txt") || file.endsWith("pyproject.toml"))) stack.add("python");
  if (files.some((file) => file.includes("fastapi") || file.endsWith("main.py"))) stack.add("fastapi-candidate");
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  if (deps.react) stack.add("react");
  if (deps.express) stack.add("express");
  if (deps.vite) stack.add("vite");
  return [...stack].sort();
}

const RepoScanInput = z.object({
  path: z.string().default("."),
  maxFiles: z.number().int().min(10).max(2000).default(300),
  maxDepth: z.number().int().min(1).max(12).default(5)
});

type RepoScanInput = z.infer<typeof RepoScanInput>;

export function createRepoScanTool(cwd: string): ToolDefinition<RepoScanInput, { root: string; files: string[]; stack: string[]; package?: unknown }> {
  return {
    name: "repo.scan",
    description: "Scan the workspace tree, detect project stack, and summarize the repo without reading every file.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to scan." },
        maxFiles: { type: "number", description: "Maximum files/directories to return." },
        maxDepth: { type: "number", description: "Maximum recursive depth." }
      }
    },
    validate(input) { return RepoScanInput.parse(input); },
    async execute(call) {
      const root = assertInsideWorkspace(call.input.path, cwd);
      const files = await walk(root, root, call.input.maxFiles, call.input.maxDepth);
      let packageJson: unknown = undefined;
      try {
        packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      } catch {}
      const stack = detectStack(files, packageJson);
      return {
        ok: true,
        toolName: "repo.scan",
        callId: call.id,
        output: { root, files, stack, package: packageJson },
        summary: `Scanned ${files.length} entries. Detected stack: ${stack.join(", ") || "unknown"}.`,
        audit: { root, maxFiles: call.input.maxFiles, maxDepth: call.input.maxDepth }
      };
    }
  };
}

const CodeSearchInput = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  maxFiles: z.number().int().min(10).max(1000).default(250),
  maxMatches: z.number().int().min(1).max(200).default(50),
  caseSensitive: z.boolean().default(false)
});

type CodeSearchInput = z.infer<typeof CodeSearchInput>;

export function createCodeSearchTool(cwd: string): ToolDefinition<CodeSearchInput, { matches: Array<{ path: string; line: number; text: string }> }> {
  return {
    name: "code.search",
    description: "Search text/code files inside the workspace for a string and return matching lines.",
    riskLevel: "low",
    requiresApproval: false,
    allowedPermissionModes: ["read_only", "draft_only", "approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        path: { type: "string", description: "Relative path to search." },
        maxFiles: { type: "number" },
        maxMatches: { type: "number" },
        caseSensitive: { type: "boolean" }
      },
      required: ["query"]
    },
    validate(input) { return CodeSearchInput.parse(input); },
    async execute(call) {
      const root = assertInsideWorkspace(call.input.path, cwd);
      const entries = (await walk(root, root, call.input.maxFiles, 12)).filter((item) => !item.endsWith("/"));
      const needle = call.input.caseSensitive ? call.input.query : call.input.query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const rel of entries) {
        if (matches.length >= call.input.maxMatches) break;
        const full = join(root, rel);
        const extension = extname(full);
        if (extension && !textExtensions.has(extension)) continue;
        const info = await stat(full).catch(() => undefined);
        if (!info?.isFile() || info.size > 500000) continue;
        const content = await readFile(full, "utf8").catch(() => "");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < call.input.maxMatches; index++) {
          const hay = call.input.caseSensitive ? lines[index] : lines[index].toLowerCase();
          if (hay.includes(needle)) matches.push({ path: relative(cwd, full), line: index + 1, text: lines[index].slice(0, 300) });
        }
      }
      return {
        ok: true,
        toolName: "code.search",
        callId: call.id,
        output: { matches },
        summary: `Found ${matches.length} matches for '${call.input.query}'.`,
        audit: { query: call.input.query, root, maxFiles: call.input.maxFiles, maxMatches: call.input.maxMatches }
      };
    }
  };
}

const PatchInput = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  expectedMatches: z.number().int().min(1).max(100).default(1)
});

type PatchInput = z.infer<typeof PatchInput>;

export function createFilePatchTool(cwd: string): ToolDefinition<PatchInput, { path: string; replacements: number }> {
  return {
    name: "file.patch",
    description: "Patch an existing text file by replacing exact text. Requires approval.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path." },
        find: { type: "string", description: "Exact text to replace." },
        replace: { type: "string", description: "Replacement text." },
        expectedMatches: { type: "number", description: "Expected replacement count." }
      },
      required: ["path", "find", "replace"]
    },
    validate(input) { return PatchInput.parse(input); },
    async execute(call) {
      const full = assertInsideWorkspace(call.input.path, cwd);
      const content = await readFile(full, "utf8");
      const count = content.split(call.input.find).length - 1;
      if (count !== call.input.expectedMatches) {
        throw new Error(`Patch expected ${call.input.expectedMatches} match(es), found ${count}. No file was changed.`);
      }
      const updated = content.split(call.input.find).join(call.input.replace);
      await writeFile(full, updated, "utf8");
      return {
        ok: true,
        toolName: "file.patch",
        callId: call.id,
        output: { path: full, replacements: count },
        summary: `Patched ${count} replacement(s) in ${full}.`,
        audit: { path: full, replacements: count }
      };
    }
  };
}

const ScaffoldInput = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/),
  template: z.enum(["typescript-cli", "fastapi-api", "static-dashboard"]),
  targetDir: z.string().default("generated")
});

type ScaffoldInput = z.infer<typeof ScaffoldInput>;

function scaffoldFiles(input: ScaffoldInput): Record<string, string> {
  if (input.template === "typescript-cli") {
    return {
      "package.json": JSON.stringify({
        name: input.name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { dev: "tsx src/index.ts", build: "tsc -p tsconfig.json", start: "node dist/index.js" },
        dependencies: {},
        devDependencies: { "@types/node": "latest", tsx: "latest", typescript: "latest" }
      }, null, 2),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist", rootDir: "src" }, include: ["src"] }, null, 2),
      "src/index.ts": `console.log("${input.name} is alive.");\n`,
      "README.md": `# ${input.name}\n\nGenerated by Goatmez Agent OS Developer Agent.\n`
    };
  }
  if (input.template === "fastapi-api") {
    return {
      "requirements.txt": "fastapi\nuvicorn[standard]\npython-dotenv\n",
      "app/main.py": "from fastapi import FastAPI\n\napp = FastAPI(title=\"Generated API\")\n\n@app.get(\"/health\")\ndef health():\n    return {\"ok\": True}\n",
      "README.md": `# ${input.name}\n\nRun with:\n\n\`\`\`bash\npython -m venv .venv\nsource .venv/bin/activate\npip install -r requirements.txt\nuvicorn app.main:app --reload\n\`\`\`\n`
    };
  }
  return {
    "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>${input.name}</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>${input.name}</h1><p>Generated dashboard shell.</p></main><script src="app.js"></script></body></html>\n`,
    "styles.css": "body{font-family:system-ui;margin:40px;background:#0f172a;color:#e5e7eb}main{max-width:900px;margin:auto}\n",
    "app.js": "console.log('dashboard ready');\n",
    "README.md": `# ${input.name}\n\nStatic dashboard scaffold generated by Goatmez Agent OS.\n`
  };
}

export function createProjectScaffoldTool(cwd: string): ToolDefinition<ScaffoldInput, { target: string; files: string[] }> {
  return {
    name: "project.scaffold",
    description: "Create a new starter project from an approved template. Requires approval.",
    riskLevel: "high",
    requiresApproval: true,
    allowedPermissionModes: ["approval_required", "workspace_write", "trusted_operator"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project folder name." },
        template: { type: "string", enum: ["typescript-cli", "fastapi-api", "static-dashboard"] },
        targetDir: { type: "string", description: "Parent directory relative to workspace." }
      },
      required: ["name", "template"]
    },
    validate(input) { return ScaffoldInput.parse(input); },
    async execute(call) {
      const target = assertInsideWorkspace(join(call.input.targetDir, call.input.name), cwd);
      const files = scaffoldFiles(call.input);
      for (const [rel, content] of Object.entries(files)) {
        const full = join(target, rel);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, { encoding: "utf8", flag: "wx" });
      }
      return {
        ok: true,
        toolName: "project.scaffold",
        callId: call.id,
        output: { target, files: Object.keys(files) },
        summary: `Created ${Object.keys(files).length} files for ${call.input.template} at ${target}.`,
        audit: { target, template: call.input.template, files: Object.keys(files) }
      };
    }
  };
}
