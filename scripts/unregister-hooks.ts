#!/usr/bin/env bun

/**
 * Remove BetterDB Memory lifecycle hooks from ~/.claude/settings.json.
 *
 * Only removes hook entries whose commands contain "betterdb-memory" or
 * "betterdb" in the path. Other hooks from other plugins are preserved.
 *
 * Usage:
 *   bun run scripts/unregister-hooks.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
const settingsPath = join(HOME, ".claude", "settings.json");

if (!existsSync(settingsPath)) {
  console.log("No ~/.claude/settings.json found — nothing to remove.");
  process.exit(0);
}

let settings: Record<string, unknown>;
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
} catch {
  console.error("ERROR: Could not parse ~/.claude/settings.json");
  process.exit(1);
}

const hooks = settings["hooks"];
if (!hooks || typeof hooks !== "object") {
  console.log("No hooks found in ~/.claude/settings.json — nothing to remove.");
  process.exit(0);
}

const hooksObj = hooks as Record<string, unknown[]>;
const BETTERDB_PATTERN = /betterdb/i;
let removedCount = 0;

for (const [event, entries] of Object.entries(hooksObj)) {
  if (!Array.isArray(entries)) continue;

  const filtered = entries.filter((entry) => {
    if (typeof entry !== "object" || entry === null) return true;
    const hooksList = (entry as Record<string, unknown>)["hooks"];
    if (!Array.isArray(hooksList)) return true;

    // Keep this entry if ANY of its hooks are NOT betterdb-related
    const hasBetterdb = hooksList.some((h) => {
      if (typeof h !== "object" || h === null) return false;
      const command = (h as Record<string, unknown>)["command"];
      return typeof command === "string" && BETTERDB_PATTERN.test(command);
    });

    if (hasBetterdb) removedCount++;
    return !hasBetterdb;
  });

  if (filtered.length === 0) {
    delete hooksObj[event];
  } else {
    hooksObj[event] = filtered;
  }
}

// If hooks object is now empty, remove it entirely
if (Object.keys(hooksObj).length === 0) {
  delete settings["hooks"];
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

if (removedCount > 0) {
  console.log(`BetterDB Memory — Removed ${removedCount} hook(s) from ~/.claude/settings.json`);
} else {
  console.log("No BetterDB Memory hooks found in ~/.claude/settings.json.");
}
