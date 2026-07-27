import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { locateDrainCommand } from "../../src/hooks/locate-drain.js";

const root = mkdtempSync(join(tmpdir(), "locate-drain-"));

function dir(name: string, files: string[] = []): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) {
    writeFileSync(join(d, f), "");
  }
  return d;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("locateDrainCommand", () => {
  test("prefers the drain binary sitting next to the running executable", async () => {
    const execDir = dir("exec-with-drain", ["drain"]);
    const installBinDir = dir("bin-with-drain", ["drain"]);
    const sourceDir = dir("src-with-drain", ["drain.ts"]);

    const cmd = await locateDrainCommand({ execDir, installBinDir, sourceDir });

    expect(cmd).toEqual([join(execDir, "drain")]);
  });

  test("falls back to the install bin dir when the executable has no sibling", async () => {
    const execDir = dir("exec-empty-1");
    const installBinDir = dir("bin-with-drain-2", ["drain"]);
    const sourceDir = dir("src-with-drain-2", ["drain.ts"]);

    const cmd = await locateDrainCommand({ execDir, installBinDir, sourceDir });

    expect(cmd).toEqual([join(installBinDir, "drain")]);
  });

  test("falls back to bun-running the source in the dev shape", async () => {
    const execDir = dir("exec-empty-2");
    const installBinDir = dir("bin-empty-2");
    const sourceDir = dir("src-with-drain-3", ["drain.ts"]);

    const cmd = await locateDrainCommand({ execDir, installBinDir, sourceDir });

    expect(cmd).toEqual(["bun", "run", join(sourceDir, "drain.ts")]);
  });

  test("returns null when no shape provides a drain", async () => {
    // The compiled-binary trap this function exists to close: sourceDir is a
    // bunfs virtual path inside the executable, so drain.ts never exists there.
    const execDir = dir("exec-empty-3");
    const installBinDir = dir("bin-empty-3");
    const sourceDir = join(root, "does-not-exist");

    const cmd = await locateDrainCommand({ execDir, installBinDir, sourceDir });

    expect(cmd).toBeNull();
  });
});
