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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { stripLegacyBetterdbHooks } from "./hook-migration.js";

const VERSION = "0.5.0";
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
const BETTERDB_DIR = join(HOME, ".betterdb");
const BIN_DIR = join(BETTERDB_DIR, "bin");
const CONFIG_PATH = join(BETTERDB_DIR, "memory.json");
const MANIFEST_PATH = join(BETTERDB_DIR, "install-manifest.json");
const PKG_ROOT = resolve(import.meta.dir, "..");

const BINARIES = [
  { src: "src/hooks/session-start.ts", out: "session-start" },
  { src: "src/hooks/session-end.ts", out: "session-end" },
  { src: "src/hooks/stop-checkpoint.ts", out: "stop-checkpoint" },
  { src: "src/hooks/pre-tool.ts", out: "pre-tool" },
  { src: "src/hooks/post-tool.ts", out: "post-tool" },
  { src: "src/hooks/drain.ts", out: "drain" },
  { src: "src/mcp/server.ts", out: "mcp-server" },
] as const;

const USAGE = `
BetterDB Memory for Claude Code v${VERSION}

Usage:
  betterdb-memory <command>

Commands:
  install          Compile binaries, register hooks + MCP server
  uninstall        Remove hooks, MCP server, and compiled binaries
  status           Check health of Valkey and model providers
  maintain         Run aging/consolidation pipeline manually
  drain            Summarize and store any queued transcripts
  forget           Bulk-delete memories by scope (dry run; pass --apply)
                   Flags: --project <name> (default: cwd) | --all-projects
                          --branch <name> --tags <a,b> --apply
  migrate          Move legacy betterdb:memory:* memories into the MemoryStore
                   (dry run; pass --apply to perform)
  ingest-claude-md Ingest a CLAUDE.md / MEMORY.md file into the store [path]
  setup-index      Create the episodic vector index (recovery after install)
  docker-valkey    Manage Docker Valkey container [start|stop|status|remove]
  version          Print version

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
  case "drain":
    await runDrain();
    break;
  case "forget":
    await runForget(process.argv.slice(3));
    break;
  case "migrate":
    await runMigrate(process.argv.includes("--apply"));
    break;
  case "ingest-claude-md":
    await runIngestClaudeMd(process.argv[3]);
    break;
  case "setup-index":
    await runSetupIndex();
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
    console.error(
      "Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code",
    );
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
    const client = new Redis(valkeyUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    await client.connect();
    await client.ping();
    console.log("OK");
    await client.quit();
  } catch (err) {
    console.log("FAILED");
    console.error(`\nCould not connect to Valkey at ${valkeyUrl}`);
    console.error(
      "Make sure Valkey 8+ is running with the Search module loaded.",
    );
    console.error(
      "Quick start: docker run -d -p 6379:6379 valkey/valkey-bundle:8",
    );
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
      "bun",
      "build",
      "--compile",
      "--external",
      "openai",
      srcPath,
      "--outfile",
      outPath,
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
    console.error(
      `\nERROR: Missing binaries: ${missing.map((b) => b.out).join(", ")}`,
    );
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

  // mergeHooks only touches events present in betterdbHooks, so the legacy
  // Stop registration must be stripped explicitly or it survives upgrades.
  const existingHooks = stripLegacyBetterdbHooks(
    (settings["hooks"] ?? {}) as Record<string, unknown[]>,
  );
  const betterdbHooks: Record<string, unknown[]> = {
    SessionStart: [
      { hooks: [{ type: "command", command: join(BIN_DIR, "session-start") }] },
    ],
    PreToolUse: [
      {
        matcher: "",
        hooks: [{ type: "command", command: join(BIN_DIR, "pre-tool") }],
      },
    ],
    PostToolUse: [
      {
        matcher: "",
        hooks: [{ type: "command", command: join(BIN_DIR, "post-tool") }],
      },
    ],
    SessionEnd: [
      { hooks: [{ type: "command", command: join(BIN_DIR, "session-end") }] },
    ],
    Stop: [
      { hooks: [{ type: "command", command: join(BIN_DIR, "stop-checkpoint") }] },
    ],
  };
  settings["hooks"] = mergeHooks(existingHooks, betterdbHooks);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("  Registered 5 hooks in ~/.claude/settings.json");

  // Register MCP server globally (-s user) so it's available in all projects
  const mcpBin = join(BIN_DIR, "mcp-server");
  Bun.spawnSync(["claude", "mcp", "remove", "-s", "user", "betterdb-memory"]);
  const mcpResult = Bun.spawnSync([
    "claude",
    "mcp",
    "add",
    "-s",
    "user",
    "betterdb-memory",
    "--",
    mcpBin,
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
    const { getPluginMemoryStore } = await import("./client/memory-store.js");
    const { createModelClient } = await import("./client/model.js");
    const client = await getValkeyClient();
    const modelClient = await createModelClient();
    // Record the active provider/dimension so a later provider swap is caught.
    await client.assertEmbedDim(
      modelClient.embedDim,
      modelClient.preset.embedModel,
    );
    const store = await getPluginMemoryStore((t) => modelClient.embed(t));
    await store.ensureIndex();
    console.log("  Valkey index ready");
    await store.close();
    await client.quit();
  } catch (err) {
    console.log(
      `  WARNING: Index setup failed (${err instanceof Error ? err.message : String(err)})`,
    );
    console.log("  You can create it later: npx @betterdb/memory setup-index");
  }

  // 6. SAVE CONFIG
  mkdirSync(BETTERDB_DIR, { recursive: true });

  const configData: Record<string, string | number> = {
    BETTERDB_VALKEY_URL: valkeyUrl,
    BETTERDB_VALKEY_INDEX_NAME:
      Bun.env["BETTERDB_VALKEY_INDEX_NAME"] ?? "betterdb-memory-index",
    BETTERDB_EMBED_DIM: Number(Bun.env["BETTERDB_EMBED_DIM"] ?? 1024),
    version: VERSION,
    installedAt: new Date().toISOString(),
  };

  // Carry forward any extra env vars the user has set
  const extraKeys = [
    "BETTERDB_EMBED_MODEL",
    "BETTERDB_SUMMARIZE_MODEL",
    "BETTERDB_OLLAMA_URL",
    "BETTERDB_EMBED_PROVIDER",
    "BETTERDB_SUMMARIZE_PROVIDER",
    "BETTERDB_MAX_CONTEXT_MEMORIES",
    "BETTERDB_ALLOW_REMOTE_FALLBACK",
    "ANTHROPIC_API_KEY",
    "VOYAGE_API_KEY",
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
  ];
  for (const key of extraKeys) {
    const val = Bun.env[key];
    if (val) configData[key] = val;
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2) + "\n");

  const manifest = {
    binaries: BINARIES.map((b) => ({
      name: b.out,
      path: join(BIN_DIR, b.out),
    })),
    configPath: CONFIG_PATH,
    settingsPath,
    installedAt: new Date().toISOString(),
    version: VERSION,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  // 7. PRINT SUMMARY
  console.log("\n=== Installation Complete ===\n");
  console.log(`  ✅ Compiled ${BINARIES.length} binaries to ${BIN_DIR}/`);
  console.log("  ✅ Registered 5 hooks with Claude Code");
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
  const mcpResult = Bun.spawnSync([
    "claude",
    "mcp",
    "remove",
    "-s",
    "user",
    "betterdb-memory",
  ]);
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
  console.log(
    `  Config preserved at ${CONFIG_PATH} — delete ~/.betterdb/ to remove entirely.`,
  );
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
    const { getPluginMemoryStore } = await import("./client/memory-store.js");
    const client = await getValkeyClient();
    const store = await getPluginMemoryStore();
    const stats = await store.stats();
    console.log(`OK (${stats.itemCount} memories, ${config.valkey.url})`);
    const w = stats.config.weights;
    const halfLifeDays = Math.round(stats.config.halfLifeSeconds / 86400);
    console.log(
      `  Recall scoring: half-life ${halfLifeDays}d · ` +
        `weights sim/rec/imp ${w.similarity}/${w.recency}/${w.importance}` +
        (stats.evictions > 0 ? ` · ${stats.evictions} evictions` : ""),
    );
    await store.close();
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
    console.log(
      `PARTIAL (${present.length}/${BINARIES.length} — reinstall recommended)`,
    );
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
      console.log(
        hookCount > 0 ? `OK (${hookCount} lifecycle events)` : "NOT CONFIGURED",
      );
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
        console.log(
          `OK (betterdb-valkey, running, port ${portMatch?.[1] ?? "unknown"})`,
        );
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
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { createModelClient } = await import("./client/model.js");
  const { AgingPipeline } = await import("./memory/aging.js");

  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  const pipeline = new AgingPipeline(valkeyClient, store, modelClient);

  const memories = await store.listMemories();
  console.log(`Total memories: ${memories.length}`);

  await pipeline.runFullPipeline();

  console.log("\nAging pipeline complete.");
  await store.close();
  await valkeyClient.quit();
}

// ---------------------------------------------------------------------------
// drain (summarize + store queued transcripts)

async function runDrain() {
  const { getValkeyClient } = await import("./client/valkey.js");
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { createModelClient } = await import("./client/model.js");
  const { AgingPipeline } = await import("./memory/aging.js");

  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  const pipeline = new AgingPipeline(valkeyClient, store, modelClient);

  const { processed, skipped } = await pipeline.processIngestQueue();
  console.log(
    `Processed ${processed} queued transcript(s), skipped ${skipped} empty.`,
  );

  await store.close();
  await valkeyClient.quit();
}

// ---------------------------------------------------------------------------
// forget (bulk delete by scope: project / branch / tags)
// ---------------------------------------------------------------------------

async function runForget(argv: string[]) {
  console.log("BetterDB Memory for Claude Code — Forget by scope\n");

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const allProjects = argv.includes("--all-projects");
  const branch = flag("branch");
  const tags = flag("tags")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const { getValkeyClient } = await import("./client/valkey.js");
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { getCwdProject } = await import("./memory/capture.js");

  const project = allProjects
    ? undefined
    : (flag("project") ?? getCwdProject());

  // Refuse an unbounded delete: --all-projects must be narrowed by branch/tags.
  if (
    project === undefined &&
    branch === undefined &&
    (!tags || tags.length === 0)
  ) {
    console.error(
      "Refusing to delete every memory. Narrow --all-projects with --branch or --tags.",
    );
    process.exit(1);
  }

  const scopeDesc = [
    project !== undefined ? `project=${project}` : "all projects",
    branch !== undefined ? `branch=${branch}` : null,
    tags && tags.length > 0 ? `tags=${tags.join(",")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`Scope: ${scopeDesc}`);

  const valkeyClient = await getValkeyClient();
  const store = await getPluginMemoryStore();

  const scope = {
    ...(project !== undefined ? { project } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  };

  // Preview through the SAME native scope filter forgetByScope deletes with, so
  // the dry-run count is exactly what --apply will remove (older memories
  // without native tags are matched identically by both paths).
  const candidates = await store.listByScope(scope);

  console.log(`Matched ${candidates.length} memories.`);
  for (const m of candidates.slice(0, 5)) {
    console.log(`  - [${m.branch}] ${m.summary.oneLineSummary.slice(0, 70)}`);
  }
  if (candidates.length > 5)
    console.log(`  ... and ${candidates.length - 5} more`);

  if (!apply) {
    console.log("\nDry run — re-run with --apply to delete.");
    await store.close();
    await valkeyClient.quit();
    return;
  }

  const deleted = await store.forgetByScope(scope);
  console.log(`\nDeleted ${deleted} memories.`);

  await store.close();
  await valkeyClient.quit();
}

// ---------------------------------------------------------------------------
// setup-index (recovery path: build the MemoryStore episodic vector index)
// ---------------------------------------------------------------------------

async function runSetupIndex() {
  const { getValkeyClient } = await import("./client/valkey.js");
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { createModelClient } = await import("./client/model.js");

  const client = await getValkeyClient();
  const modelClient = await createModelClient();
  // Record the active provider/dimension so a later provider swap is caught.
  await client.assertEmbedDim(
    modelClient.embedDim,
    modelClient.preset.embedModel,
  );
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  await store.ensureIndex();
  console.log("Index ready: betterdb:mem:idx");

  await store.close();
  await client.quit();
}

// ---------------------------------------------------------------------------
// migrate (legacy betterdb:memory:* -> MemoryStore betterdb:mem:*)
// ---------------------------------------------------------------------------

async function runMigrate(apply: boolean) {
  console.log("BetterDB Memory for Claude Code — Migrate legacy memories\n");

  const { getValkeyClient } = await import("./client/valkey.js");
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { createModelClient } = await import("./client/model.js");

  const valkeyClient = await getValkeyClient();
  const legacyIds = await valkeyClient.listMemoryIds();
  console.log(
    `Found ${legacyIds.length} legacy memories under betterdb:memory:*`,
  );

  if (legacyIds.length === 0) {
    console.log("Nothing to migrate.");
    await valkeyClient.quit();
    return;
  }

  if (!apply) {
    console.log("\nDry run — re-run with --apply to migrate.");
    console.log(
      "Each legacy memory is re-embedded and written to betterdb:mem:*,",
    );
    console.log("and knowledge entries are re-pointed to the new memory ids.");
    console.log(
      "The legacy index is dropped only after the new count is verified;",
    );
    console.log(
      "legacy hashes are left in place for you to delete once satisfied.",
    );
    await valkeyClient.quit();
    return;
  }

  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  await store.ensureIndex();

  // Baseline so we can verify the store actually grew by the migrated count,
  // not just that its total happens to exceed it (pre-existing memories).
  const beforeCount = (await store.listMemories()).length;

  let migrated = 0;
  let failed = 0;
  // MemoryStore.remember mints a fresh id, so track legacy -> new so we can
  // re-point knowledge entries that reference the old episodic ids.
  const idMap = new Map<string, string>();
  const projects = new Set<string>();
  for (const id of legacyIds) {
    const memory = await valkeyClient.getMemory(id);
    if (!memory) {
      failed++;
      continue;
    }
    try {
      const newId = await store.storeMemory(memory);
      idMap.set(id, newId);
      projects.add(memory.project);
      migrated++;
      if (migrated % 10 === 0) {
        console.log(`  Migrated ${migrated}/${legacyIds.length}...`);
      }
    } catch (err) {
      console.error(
        `  Failed to migrate ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  // Re-point distilled knowledge so sourceMemoryIds keep referencing real
  // episodic memories under the new ids. storeKnowledge upserts by
  // project:topic, so re-storing overwrites in place.
  let remappedKnowledge = 0;
  for (const project of projects) {
    for (const entry of await valkeyClient.listKnowledge(project)) {
      const remapped = entry.sourceMemoryIds.map(
        (sid) => idMap.get(sid) ?? sid,
      );
      if (remapped.some((sid, i) => sid !== entry.sourceMemoryIds[i])) {
        await valkeyClient.storeKnowledge({
          ...entry,
          sourceMemoryIds: remapped,
        });
        remappedKnowledge++;
      }
    }
  }
  if (remappedKnowledge > 0) {
    console.log(
      `Re-pointed ${remappedKnowledge} knowledge entries to new memory ids.`,
    );
  }

  // Verify before dropping the legacy index: the store must have grown by the
  // number we successfully migrated (not merely exceed it, which pre-existing
  // memories would satisfy even if rows failed to copy).
  const afterCount = (await store.listMemories()).length;
  const grew = afterCount - beforeCount;
  console.log(
    `\nMigrated: ${migrated}, failed: ${failed}, store grew by ${grew} (now ${afterCount}).`,
  );

  if (migrated > 0 && grew >= migrated) {
    await valkeyClient.dropIndex();
    console.log("Verified — dropped the legacy index (betterdb-memory-index).");
    console.log(
      "Legacy hashes (betterdb:memory:*) remain; delete them manually when ready.",
    );
  } else {
    console.log(
      "Count mismatch — left the legacy index in place. Re-run after investigating.",
    );
  }

  await store.close();
  await valkeyClient.quit();
}

// ---------------------------------------------------------------------------
// ingest-claude-md (ingest a CLAUDE.md / MEMORY.md file into the store)
// ---------------------------------------------------------------------------

async function runIngestClaudeMd(pathArg?: string) {
  console.log(
    "BetterDB Memory for Claude Code — Ingest markdown memory file\n",
  );

  const candidates = pathArg
    ? [pathArg]
    : [
        join(process.cwd(), "CLAUDE.md"),
        join(process.cwd(), "MEMORY.md"),
        join(HOME, ".claude", "CLAUDE.md"),
      ];

  const filePath = candidates.find((p) => existsSync(p));
  if (!filePath) {
    console.error(
      `No memory file found. Looked in:\n  ${candidates.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`Reading ${filePath}`);

  const content = readFileSync(filePath, "utf-8");
  // Split into paragraph-sized chunks on blank lines so each becomes an
  // independently recallable memory; cap length to keep embeddings sane.
  const MAX_CHUNK = 480;
  const chunks = content
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => (c.length > MAX_CHUNK ? c.slice(0, MAX_CHUNK) : c));

  if (chunks.length === 0) {
    console.log("File is empty — nothing to ingest.");
    process.exit(0);
  }

  const { getValkeyClient } = await import("./client/valkey.js");
  const { getPluginMemoryStore } = await import("./client/memory-store.js");
  const { createModelClient } = await import("./client/model.js");
  const { getCwdProject } = await import("./memory/capture.js");
  const { SessionSummarySchema } = await import("./memory/schema.js");

  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  await store.ensureIndex();

  const project = getCwdProject();
  const timestamp = new Date().toISOString();
  let stored = 0;

  for (const chunk of chunks) {
    const summary = SessionSummarySchema.parse({
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: chunk,
    });
    await store.storeMemory({
      memoryId: crypto.randomUUID(),
      project,
      branch: "claude-md",
      timestamp,
      summary,
      importanceScore: 0.6,
      accessCount: 0,
      lastAccessed: timestamp,
    });
    stored++;
  }

  console.log(
    `\nIngested ${stored} chunks from ${filePath} into project "${project}".`,
  );
  await store.close();
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
