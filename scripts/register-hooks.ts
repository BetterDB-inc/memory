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
import {
  HOOK_SPECS,
  buildHookMap,
  formatHookSummary,
  isOwnHookEntry,
  type HookSpec,
} from "../src/hook-spec.js";

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error("Usage: bun run register-hooks.ts <plugin-root>");
  process.exit(1);
}

const resolvedRoot = resolve(pluginRoot);
const hooksDir = join(resolvedRoot, "src", "hooks");

// Verify hook source files exist
for (const spec of HOOK_SPECS) {
  if (!existsSync(join(hooksDir, spec.source))) {
    console.error(
      `ERROR: Hook source not found: ${join(hooksDir, spec.source)}`,
    );
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
    console.warn(
      "WARNING: Could not parse ~/.claude/settings.json — existing content will be preserved as backup.",
    );
    const backupPath = settingsPath + ".bak";
    writeFileSync(backupPath, readFileSync(settingsPath));
    console.warn(`  Backup saved to ${backupPath}`);
  }
}

function cmd(spec: HookSpec): string {
  return `bash -c 'bun run "${join(hooksDir, spec.source)}"'`;
}

// Merge hooks — replaces BetterDB entries per event, preserves all others.
const existingHooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
const betterdbHooks = buildHookMap(cmd);

for (const [event, entries] of Object.entries(betterdbHooks)) {
  const prev = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
  const filtered = prev.filter((entry) => {
    return !isOwnHookEntry(entry, [hooksDir, "betterdb"]);
  });
  existingHooks[event] = [...filtered, ...entries];
}
settings["hooks"] = existingHooks;

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

console.log("BetterDB Memory — Hooks registered in ~/.claude/settings.json\n");
for (const line of formatHookSummary()) {
  console.log(line);
}
console.log(`\n  Plugin root: ${resolvedRoot}`);
console.log("\n  Restart Claude Code for hooks to take effect.");
