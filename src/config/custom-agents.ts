/**
 * custom-agents.ts — Load user-defined agents from Pi packages, project
 * (.pi/agents/), and global ($PI_CODING_AGENT_DIR/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import type { AgentConfig, ThinkingLevel } from "#src/types";

/**
 * Scan for custom agent .md files. Higher-priority sources overwrite lower ones:
 * project > global > package > embedded defaults (merged by AgentTypeRegistry).
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  for (const dir of loadPackageAgentDirs(cwd)) loadFromDir(dir, agents, "package");
  loadFromDir(join(getAgentDir(), "agents"), agents, "global");
  loadFromDir(join(cwd, ".pi", "agents"), agents, "project");
  return agents;
}

/** Discover agent directories from packages explicitly configured in Pi settings. */
function loadPackageAgentDirs(cwd: string): string[] {
  const projectDir = join(cwd, ".pi");
  const agentDir = getAgentDir();
  const roots = [
    ...packageRootsFromSettings(join(agentDir, "settings.json"), agentDir),
    ...packageRootsFromSettings(join(projectDir, "settings.json"), projectDir),
  ];

  return [...new Set(roots.flatMap(agentDirsFromPackage))];
}

function agentDirsFromPackage(packageRoot: string): string[] {
  const file = join(packageRoot, "package.json");
  const manifest = record(readJson(file));
  if (!manifest) {
    if (existsSync(packageRoot)) console.warn(`[pi-subagents] Ignoring package without a valid manifest at ${packageRoot}`);
    return [];
  }

  const agents = record(manifest.pi)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((entry): entry is string => typeof entry === "string" && safePackagePath(entry))
    .map(entry => resolve(packageRoot, entry));
}

function packageRootsFromSettings(file: string, baseDir: string): string[] {
  const packages = record(readJson(file))?.packages;
  if (!Array.isArray(packages)) return [];

  return packages.flatMap(entry => {
    const source = typeof entry === "string" ? entry : record(entry)?.source;
    const root = typeof source === "string" ? resolvePackageSource(source.trim(), baseDir) : undefined;
    return root ? [root] : [];
  });
}

function resolvePackageSource(source: string, baseDir: string): string | undefined {
  if (source.startsWith("npm:")) {
    const name = source.slice(4).match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/)?.[1];
    return name && safePackagePath(name) ? join(baseDir, "npm", "node_modules", name) : undefined;
  }
  if (/^(?:git:|git\+|https?:|ssh:)/i.test(source)) return undefined;

  const path = source.startsWith("file:") ? source.slice(5) : source;
  return path ? resolve(baseDir, path) : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safePackagePath(value: string): boolean {
  const path = value.replace(/^\.([\\/])/, "");
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)
    && path.split(/[\\/]/).every(part => part.length > 0 && part !== "." && part !== "..");
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global" | "package"): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(file => file.endsWith(".md"));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      console.warn(`[pi-subagents] Ignoring unreadable agent file ${join(dir, file)}`);
      debugLog("readFileSync agent file", err);
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(content);
    } catch (err) {
      console.warn(`[pi-subagents] Ignoring invalid agent file ${join(dir, file)}`);
      debugLog("parseFrontmatter agent file", err);
      continue;
    }
    const { frontmatter: fm, body } = parsed;
    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      enabled: fm.enabled !== false,
      source,
    });
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 ? value : undefined;
}

function parseCsvField(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional frontmatter coercion
  const text = String(value).trim();
  if (!text || text === "none") return undefined;
  const items = text.split(",").map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function csvList(value: unknown, defaults: string[]): string[] {
  if (value === undefined || value === null) return defaults;
  return parseCsvField(value) ?? [];
}
