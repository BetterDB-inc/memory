#!/usr/bin/env bun

/**
 * Compile each hook entry point in HOOK_SPECS, plus the companion binaries
 * hooks spawn at runtime, to standalone binaries.
 *
 * Usage:
 *   bun run scripts/build-hooks.ts
 *
 * Sources live in src/hooks/<spec.source>; binaries are written to
 * dist/hooks/<spec.binary>, the paths install-hooks.sh registers.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANION_BINARIES, HOOK_SPECS } from "../src/hook-spec.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = join(projectRoot, "src", "hooks");
const outDir = join(projectRoot, "dist", "hooks");

const OPTIONAL_PROVIDERS = ["openai"];

mkdirSync(outDir, { recursive: true });

const specs = [...HOOK_SPECS, ...COMPANION_BINARIES];

for (const spec of specs) {
  const source = join(hooksDir, spec.source);
  const outfile = join(outDir, spec.binary);
  console.log(`Compiling ${spec.source} → dist/hooks/${spec.binary}`);
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      ...OPTIONAL_PROVIDERS.flatMap((pkg) => ["--external", pkg]),
      source,
      "--outfile",
      outfile,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (!result.success) {
    console.error(`ERROR: failed to compile ${spec.source}`);
    process.exit(1);
  }
}

for (const name of readdirSync(projectRoot)) {
  if (name.endsWith(".bun-build")) {
    rmSync(join(projectRoot, name), { force: true });
  }
}

console.log(`Compiled ${specs.length} binaries to dist/hooks/`);
