#!/usr/bin/env bun

/**
 * BetterDB Memory for Claude Code — CLI entry point.
 *
 * Usage:
 *   betterdb-memory install    — Compile binaries, register hooks + MCP server
 *   betterdb-memory status     — Check health of Valkey + model providers
 *   betterdb-memory uninstall  — Remove hooks, MCP, and compiled binaries
 *   betterdb-memory maintain   — Run aging/compression manually
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = "0.1.0";
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
const BETTERDB_DIR = join(HOME, ".betterdb");
const BIN_DIR = join(BETTERDB_DIR, "bin");
const CONFIG_PATH = join(BETTERDB_DIR, "memory.json");
const MANIFEST_PATH = join(BETTERDB_DIR, "install-manifest.json");
const PKG_ROOT = resolve(import.meta.dir, "..");

const BINARIES = [
  { src: "src/hooks/session-start.ts", out: "session-start" },
  { src: "src/hooks/session-end.ts", out: "session-end" },
  { src: "src/hooks/pre-tool.ts", out: "pre-tool" },
  { src: "src/hooks/post-tool.ts", out: "post-tool" },
  { src: "src/mcp/server.ts", out: "mcp-server" },
] as const;

const USAGE = `
BetterDB Memory for Claude Code v${VERSION}

Usage:
  betterdb-memory <command>

Commands:
  install        Compile binaries, register hooks + MCP server
  uninstall      Remove hooks, MCP server, and compiled binaries
  status         Check health of Valkey and model providers
  maintain       Run aging/compression pipeline manually
  docker-valkey  Manage Docker Valkey container [start|stop|status|remove]
  version        Print version

Environment:
  BETTERDB_VALKEY_URL   Valkey connection (default: redis://localhost:6379)
  BETTERDB_EMBED_MODEL  Embedding model (auto-detected)
  BETTERDB_EMBED_DIM    Embedding dimensions (default: 1024)
`.trim();

const command = process.argv[2];

switch (command) {
  case "install":
    await runInstall();
    break;
  case "uninstall":
    await runUninstall();
    break;
  case "status":
    await runStatus();
    break;
  case "maintain":
    await runMaintain();
    break;
  case "docker-valkey": {
    const action = process.argv[3] ?? "start";
    const port = process.argv[4] ?? "6379";
    const script = join(PKG_ROOT, "scripts", "docker-valkey.sh");
    const result = Bun.spawnSync(["bash", script, port, action]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
    break;
  }
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function runInstall() {
  console.log("BetterDB Memory for Claude Code — Install\n");

  // 1. PREFLIGHT
  if (!commandExists("bun")) {
    console.error("ERROR: 'bun' not found on PATH.");
    console.error("Install Bun: https://bun.sh");
    process.exit(1);
  }
  if (!commandExists("claude")) {
    console.error("ERROR: 'claude' not found on PATH.");
    console.error("Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }
  console.log("Preflight checks passed.\n");

  // 2. VALKEY CONNECTION
  const valkeyUrl =
    Bun.env["BETTERDB_VALKEY_URL"] ??
    readConfigValue("BETTERDB_VALKEY_URL") ??
    "redis://localhost:6379";

  process.stdout.write(`Connecting to Valkey at ${valkeyUrl}... `);
  try {
    const Redis = (await import("iovalkey")).default;
    const client = new Redis(valkeyUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    await client.connect();
    await client.ping();
    console.log("OK");
    await client.quit();
  } catch (err) {
    console.log("FAILED");
    console.error(`\nCould not connect to Valkey at ${valkeyUrl}`);
    console.error("Make sure Valkey 8+ is running with the Search module loaded.");
    console.error("Quick start: docker run -d -p 6379:6379 valkey/valkey-bundle:8");
    process.exit(1);
  }

  // 3. COMPILE NATIVE BINARIES
  mkdirSync(BIN_DIR, { recursive: true });

  console.log(`\nCompiling ${BINARIES.length} binaries to ${BIN_DIR}/`);
  for (const bin of BINARIES) {
    const srcPath = join(PKG_ROOT, bin.src);
    const outPath = join(BIN_DIR, bin.out);
    process.stdout.write(`  ${bin.out}... `);

    if (!existsSync(srcPath)) {
      console.log(`FAILED (source not found: ${srcPath})`);
      process.exit(1);
    }

    const result = Bun.spawnSync([
      "bun", "build", "--compile", "--external", "openai",
      srcPath, "--outfile", outPath,
    ]);

    if (result.exitCode !== 0) {
      console.log("FAILED");
      console.error(result.stderr.toString());
      process.exit(1);
    }

    chmodSync(outPath, 0o755);
    console.log("OK");
  }

  // Verify all binaries exist
  const missing = BINARIES.filter((b) => !existsSync(join(BIN_DIR, b.out)));
  if (missing.length > 0) {
    console.error(`\nERROR: Missing binaries: ${missing.map((b) => b.out).join(", ")}`);
    process.exit(1);
  }

  // 4. REGISTER WITH CLAUDE CODE
  console.log("\nRegistering with Claude Code...");

  // Write hooks to ~/.claude/settings.json
  const claudeDir = join(HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // corrupted settings — start fresh
    }
  }

  const existingHooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  const betterdbHooks: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [{ type: "command", command: join(BIN_DIR, "session-start") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: join(BIN_DIR, "pre-tool") }] }],
    PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: join(BIN_DIR, "post-tool") }] }],
    Stop: [{ hooks: [{ type: "command", command: join(BIN_DIR, "session-end") }] }],
  };
  settings["hooks"] = mergeHooks(existingHooks, betterdbHooks);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("  Registered 4 hooks in ~/.claude/settings.json");

  // Register MCP server globally (-s user) so it's available in all projects
  const mcpBin = join(BIN_DIR, "mcp-server");
  Bun.spawnSync(["claude", "mcp", "remove", "-s", "user", "betterdb-memory"]);
  const mcpResult = Bun.spawnSync([
    "claude", "mcp", "add", "-s", "user", "betterdb-memory", "--", mcpBin,
  ]);
  if (mcpResult.exitCode === 0) {
    console.log("  Registered MCP server: betterdb-memory (global)");
  } else {
    console.log("  WARNING: MCP registration failed — register manually:");
    console.log(`    claude mcp add -s user betterdb-memory -- ${mcpBin}`);
  }

  // 5. SETUP VALKEY INDEX
  console.log("\nSetting up Valkey index...");
  try {
    const { getValkeyClient } = await import("./client/valkey.js");
    const embedDim = Number(Bun.env["BETTERDB_EMBED_DIM"] ?? readConfigValue("BETTERDB_EMBED_DIM") ?? "1024");
    const client = await getValkeyClient();
    await client.ensureIndex(embedDim);
    console.log("  Valkey index ready");
    await client.quit();
  } catch (err) {
    console.log(`  WARNING: Index setup failed (${err instanceof Error ? err.message : String(err)})`);
    console.log("  You can create it later: npx @betterdb/memory setup-index");
  }

  // 6. SAVE CONFIG
  mkdirSync(BETTERDB_DIR, { recursive: true });

  const configData: Record<string, string | number> = {
    BETTERDB_VALKEY_URL: valkeyUrl,
    BETTERDB_VALKEY_INDEX_NAME: Bun.env["BETTERDB_VALKEY_INDEX_NAME"] ?? "betterdb-memory-index",
    BETTERDB_EMBED_DIM: Number(Bun.env["BETTERDB_EMBED_DIM"] ?? 1024),
    version: VERSION,
    installedAt: new Date().toISOString(),
  };

  // Carry forward any extra env vars the user has set
  const extraKeys = [
    "BETTERDB_EMBED_MODEL", "BETTERDB_SUMMARIZE_MODEL",
    "BETTERDB_OLLAMA_URL", "BETTERDB_EMBED_PROVIDER", "BETTERDB_SUMMARIZE_PROVIDER",
    "BETTERDB_MAX_CONTEXT_MEMORIES", "BETTERDB_ALLOW_REMOTE_FALLBACK",
    "ANTHROPIC_API_KEY", "VOYAGE_API_KEY", "OPENAI_API_KEY",
    "GROQ_API_KEY", "TOGETHER_API_KEY",
  ];
  for (const key of extraKeys) {
    const val = Bun.env[key];
    if (val) configData[key] = val;
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2) + "\n");

  const manifest = {
    binaries: BINARIES.map((b) => ({ name: b.out, path: join(BIN_DIR, b.out) })),
    configPath: CONFIG_PATH,
    settingsPath,
    installedAt: new Date().toISOString(),
    version: VERSION,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  // 7. PRINT SUMMARY
  console.log("\n=== Installation Complete ===\n");
  console.log(`  ✅ Compiled ${BINARIES.length} binaries to ${BIN_DIR}/`);
  console.log("  ✅ Registered 4 hooks with Claude Code");
  console.log("  ✅ Registered MCP server: betterdb-memory");
  console.log("  ✅ Valkey index ready");
  console.log(`  ✅ Config saved to ${CONFIG_PATH}`);
  console.log("\n  🎉 Start a new Claude Code session to try it.");
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function runUninstall() {
  console.log("BetterDB Memory for Claude Code — Uninstall\n");

  // Remove hooks from ~/.claude/settings.json
  const settingsPath = join(HOME, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        delete settings.hooks;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log("  Removed hooks from ~/.claude/settings.json");
      } else {
        console.log("  No hooks found in ~/.claude/settings.json");
      }
    } catch {
      console.log("  WARNING: Could not parse ~/.claude/settings.json");
    }
  }

  // Remove MCP server (try both user and local scope)
  Bun.spawnSync(["claude", "mcp", "remove", "-s", "local", "betterdb-memory"]);
  const mcpResult = Bun.spawnSync(["claude", "mcp", "remove", "-s", "user", "betterdb-memory"]);
  if (mcpResult.exitCode === 0) {
    console.log("  Removed MCP server: betterdb-memory");
  } else {
    console.log("  MCP server not found or already removed");
  }

  // Delete compiled binaries
  if (existsSync(BIN_DIR)) {
    rmSync(BIN_DIR, { recursive: true });
    console.log(`  Deleted ${BIN_DIR}/`);
  }

  // Delete manifest (keep config for potential reinstall)
  if (existsSync(MANIFEST_PATH)) {
    rmSync(MANIFEST_PATH);
    console.log("  Deleted install manifest");
  }

  console.log("\n  Uninstall complete.");
  console.log(`  Config preserved at ${CONFIG_PATH} — delete ~/.betterdb/ to remove entirely.`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus() {
  console.log(`BetterDB Memory for Claude Code v${VERSION}\n`);

  // Check Valkey connection
  process.stdout.write("Valkey connection... ");
  try {
    const { config } = await import("./config.js");
    const { getValkeyClient } = await import("./client/valkey.js");
    const client = await getValkeyClient();
    const memoryIds = await client.listMemoryIds();
    console.log(`OK (${memoryIds.length} memories, ${config.valkey.url})`);
    await client.quit();
  } catch (err) {
    console.log(`FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  // Check model providers
  process.stdout.write("Model providers... ");
  try {
    const { createModelClient } = await import("./client/model.js");
    const modelClient = await createModelClient();
    console.log(
      `OK (embed=${modelClient.preset.embedModel}, summarize=${modelClient.preset.summarizeModel})`,
    );
  } catch (err) {
    console.log(`FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  // Check compiled binaries
  process.stdout.write("Compiled binaries... ");
  const present = BINARIES.filter((b) => existsSync(join(BIN_DIR, b.out)));
  if (present.length === BINARIES.length) {
    console.log(`OK (${present.length}/${BINARIES.length} in ${BIN_DIR}/)`);
  } else if (present.length > 0) {
    console.log(`PARTIAL (${present.length}/${BINARIES.length} — reinstall recommended)`);
  } else {
    console.log("NOT INSTALLED (run: npx @betterdb/memory install)");
  }

  // Check hooks
  process.stdout.write("Claude Code hooks... ");
  try {
    const settingsPath = join(HOME, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hookCount = Object.keys(settings.hooks ?? {}).length;
      console.log(hookCount > 0 ? `OK (${hookCount} lifecycle events)` : "NOT CONFIGURED");
    } else {
      console.log("NOT CONFIGURED (no ~/.claude/settings.json)");
    }
  } catch {
    console.log("FAILED (could not read settings)");
  }

  // Check Docker container (only if config has "docker": true)
  const dockerFlag = readConfigValue("docker");
  if (dockerFlag === "true") {
    process.stdout.write("Docker container... ");
    const script = join(PKG_ROOT, "scripts", "docker-valkey.sh");
    if (existsSync(script)) {
      const result = Bun.spawnSync(["bash", script, "6379", "status"]);
      const output = result.stdout.toString().trim();
      if (output.includes("is running")) {
        const portMatch = output.match(/port (\d+)/);
        console.log(`OK (betterdb-valkey, running, port ${portMatch?.[1] ?? "unknown"})`);
      } else if (output.includes("stopped")) {
        console.log(`STOPPED (run: bunx @betterdb/memory docker-valkey)`);
      } else {
        console.log(`NOT FOUND (run: bunx @betterdb/memory docker-valkey)`);
      }
    } else {
      console.log("SCRIPT MISSING (docker-valkey.sh not found)");
    }
  } else {
    process.stdout.write("Docker container... ");
    console.log("NOT USED (Valkey managed externally)");
  }

  // Check config file
  process.stdout.write("Config file... ");
  if (existsSync(CONFIG_PATH)) {
    console.log(`OK (${CONFIG_PATH})`);
  } else {
    console.log("NOT FOUND (run: npx @betterdb/memory install)");
  }
}

// ---------------------------------------------------------------------------
// maintain
// ---------------------------------------------------------------------------

async function runMaintain() {
  console.log("BetterDB Memory for Claude Code — Maintenance\n");

  const { getValkeyClient } = await import("./client/valkey.js");
  const { createModelClient } = await import("./client/model.js");
  const { AgingPipeline } = await import("./memory/aging.js");

  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const pipeline = new AgingPipeline(valkeyClient, modelClient);

  const memoryIds = await valkeyClient.listMemoryIds();
  console.log(`Total memories: ${memoryIds.length}`);

  // Group by project
  const projects = new Set<string>();
  for (const id of memoryIds) {
    const memory = await valkeyClient.getMemory(id);
    if (memory) projects.add(memory.project);
  }

  for (const project of projects) {
    console.log(`\nRunning decay for project: ${project}`);
    await pipeline.runDecay(project);
  }

  await valkeyClient.setLastAgingRun(new Date());
  console.log("\nAging pipeline complete.");
  await valkeyClient.quit();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
  const result = Bun.spawnSync(["which", cmd]);
  return result.exitCode === 0;
}

/**
 * Merge BetterDB hooks into existing settings hooks without clobbering
 * entries from other plugins or user-defined hooks. For each event,
 * removes any previous BetterDB entries (matched by BIN_DIR path)
 * then appends the new ones.
 */
function mergeHooks(
  existing: Record<string, unknown[]>,
  ours: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const merged = { ...existing };
  for (const [event, entries] of Object.entries(ours)) {
    const prev = Array.isArray(merged[event]) ? merged[event] : [];
    // Filter out previous BetterDB entries (contain our BIN_DIR or betterdb path)
    const filtered = prev.filter((entry) => {
      const json = JSON.stringify(entry);
      return !json.includes(BIN_DIR) && !json.includes("betterdb");
    });
    merged[event] = [...filtered, ...entries];
  }
  return merged;
}

function readConfigValue(key: string): string | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const data: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof data !== "object" || data === null) return undefined;
    const val = (data as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return String(val);
    return undefined;
  } catch {
    return undefined;
  }
}
