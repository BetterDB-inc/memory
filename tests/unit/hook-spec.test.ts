import { describe, expect, test } from "bun:test";
import { isOwnHookEntry, HOOK_SPECS, buildHookMap } from "../../src/hook-spec.js";

const BIN_DIR = "/Users/x/.betterdb/bin";

function entry(command: string): unknown {
  return { hooks: [{ type: "command", command }] };
}

describe("isOwnHookEntry", () => {
  test("recognizes an installed binary entry via the BIN_DIR marker", () => {
    expect(isOwnHookEntry(entry(`${BIN_DIR}/session-end`), [BIN_DIR])).toBe(true);
  });

  test("recognizes a dev entry whose checkout path has no betterdb in it", () => {
    // The gap this predicate exists to close: register-hooks.ts points at a
    // checkout that need not be named betterdb, so a path-substring match
    // missed it and the stale entry survived install.
    const dev = entry(`bash -c 'bun run "/work/memory/src/hooks/session-end.ts"'`);
    expect(isOwnHookEntry(dev, [BIN_DIR, "betterdb"])).toBe(true);
  });

  test("recognizes a legacy Stop entry pointing at session-end from any path", () => {
    const legacy = entry(`bash -c 'bun run "/srv/clone/src/hooks/session-end.ts"'`);
    expect(isOwnHookEntry(legacy, [BIN_DIR, "betterdb"])).toBe(true);
  });

  test("does not claim a third party's hook", () => {
    expect(isOwnHookEntry(entry("/opt/other-tool/bin/their-hook"), [BIN_DIR])).toBe(
      false,
    );
  });

  test("does not claim a third party hook merely near our install", () => {
    expect(isOwnHookEntry(entry("/usr/local/bin/lint"), [BIN_DIR, "betterdb"])).toBe(
      false,
    );
  });

  test("ignores empty markers rather than matching everything", () => {
    expect(isOwnHookEntry(entry("/opt/other/hook"), [""])).toBe(false);
  });

  test("recognizes every hook this plugin registers", () => {
    const map = buildHookMap((spec) => `bash -c 'bun run "/work/memory/src/hooks/${spec.source}"'`);
    for (const spec of HOOK_SPECS) {
      const entries = map[spec.event] ?? [];
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(isOwnHookEntry(e, [BIN_DIR, "betterdb"])).toBe(true);
      }
    }
  });
});
