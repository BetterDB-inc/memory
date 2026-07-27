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

  test("recognizes a compiled binary entry from a foreign checkout", () => {
    // install-hooks.sh registers dist/hooks/<binary> wrapped in a bash -c
    // env loader — no .ts source name anywhere. A later installer passes its
    // own markers, which need not cover the old checkout's path.
    const bin = entry(
      `bash -c "set -a; [ -f /work/memory/.env ] && . /work/memory/.env; set +a; /work/memory/dist/hooks/stop-checkpoint"`,
    );
    expect(isOwnHookEntry(bin, [BIN_DIR, "betterdb"])).toBe(true);
  });

  test("recognizes every compiled hook binary this plugin registers", () => {
    const map = buildHookMap((spec) => `/work/memory/dist/hooks/${spec.binary}`);
    for (const entries of Object.values(map)) {
      for (const e of entries) {
        expect(isOwnHookEntry(e, [BIN_DIR, "betterdb"])).toBe(true);
      }
    }
  });

  test("does not claim a third party binary under its own dist/hooks", () => {
    expect(
      isOwnHookEntry(entry("/opt/tool/dist/hooks/lint"), [BIN_DIR, "betterdb"]),
    ).toBe(false);
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

  test("every registered hook carries an explicit timeout", () => {
    // Without one, Claude Code waits 60s per hook — a wedged backend held
    // every tool call hostage for minutes. Pre/post fire on each tool call
    // and must be the tightest.
    const map = buildHookMap((spec) => spec.binary);
    for (const [event, entries] of Object.entries(map)) {
      for (const entry of entries) {
        for (const cmd of entry.hooks) {
          expect(cmd.timeout).toBeGreaterThan(0);
          if (event === "PreToolUse" || event === "PostToolUse") {
            expect(cmd.timeout).toBeLessThanOrEqual(10);
          }
        }
      }
    }
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
