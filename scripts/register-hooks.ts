#!/usr/bin/env bun

/**
 * Register BetterDB Memory lifecycle hooks in ~/.claude/settings.json.
 *
 * Usage:
 *   bun run scripts/register-hooks.ts <plugin-root>
 *
 * <plugin-root> is the absolute path to the plugin directory (where src/hooks/ lives).
 * Hook commands are written with resolved absolute paths — no env vars.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error("Usage: bun run register-hooks.ts <plugin-root>");
  process.exit(1);
}

const resolvedRoot = resolve(pluginRoot);
const hooksDir = join(resolvedRoot, "src", "hooks");

// Verify hook source files exist
const hookFiles = ["session-start.ts", "pre-tool.ts", "post-tool.ts", "session-end.ts"];
for (const file of hookFiles) {
  if (!existsSync(join(hooksDir, file))) {
    console.error(`ERROR: Hook source not found: ${join(hooksDir, file)}`);
    process.exit(1);
  }
}

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
const claudeDir = join(HOME, ".claude");
const settingsPath = join(claudeDir, "settings.json");

// Ensure ~/.claude/ exists
mkdirSync(claudeDir, { recursive: true });

// Read existing settings (or start fresh)
let settings: Record<string, unknown> = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // Corrupted file — start fresh but warn
    console.warn("WARNING: Could not parse ~/.claude/settings.json — existing content will be preserved as backup.");
    const backupPath = settingsPath + ".bak";
    writeFileSync(backupPath, readFileSync(settingsPath));
    console.warn(`  Backup saved to ${backupPath}`);
  }
}

function cmd(hookFile: string): string {
  return `bash -c 'bun run "${join(hooksDir, hookFile)}"'`;
}

// Merge hooks — overwrites any previous BetterDB hooks
settings["hooks"] = {
  SessionStart: [
    { hooks: [{ type: "command", command: cmd("session-start.ts") }] },
  ],
  PreToolUse: [
    { matcher: "", hooks: [{ type: "command", command: cmd("pre-tool.ts") }] },
  ],
  PostToolUse: [
    { matcher: "", hooks: [{ type: "command", command: cmd("post-tool.ts") }] },
  ],
  Stop: [
    { hooks: [{ type: "command", command: cmd("session-end.ts") }] },
  ],
};

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

console.log("BetterDB Memory — Hooks registered in ~/.claude/settings.json\n");
console.log("  SessionStart → session-start.ts");
console.log("  PreToolUse   → pre-tool.ts");
console.log("  PostToolUse  → post-tool.ts");
console.log("  Stop         → session-end.ts");
console.log(`\n  Plugin root: ${resolvedRoot}`);
console.log("\n  Restart Claude Code for hooks to take effect.");
