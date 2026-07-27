import { describe, expect, test } from "bun:test";
import { stripLegacyBetterdbHooks } from "../../src/hook-migration.js";

describe("stripLegacyBetterdbHooks", () => {
  test("removes a betterdb Stop entry", () => {
    const hooks = {
      Stop: [
        {
          hooks: [
            { type: "command", command: "/Users/x/.betterdb/bin/session-end" },
          ],
        },
      ],
    };
    const result = stripLegacyBetterdbHooks(hooks);
    expect(result["Stop"]).toBeUndefined();
  });

  test("preserves a third-party Stop hook", () => {
    const hooks = {
      Stop: [
        {
          hooks: [
            { type: "command", command: "/Users/x/.betterdb/bin/session-end" },
          ],
        },
        { hooks: [{ type: "command", command: "/other/tool/hook" }] },
      ],
    };
    const result = stripLegacyBetterdbHooks(hooks);
    expect(result["Stop"]).toHaveLength(1);
    expect(JSON.stringify(result["Stop"])).toContain("/other/tool/hook");
  });

  test("leaves unrelated events untouched", () => {
    const hooks = {
      PreCompact: [{ hooks: [{ type: "command", command: "/other/hook" }] }],
    };
    const result = stripLegacyBetterdbHooks(hooks);
    expect(result["PreCompact"]).toHaveLength(1);
  });

  test("is a no-op on settings with no Stop event", () => {
    const hooks = { SessionStart: [{ hooks: [] }] };
    expect(stripLegacyBetterdbHooks(hooks)).toEqual(hooks);
  });

  test("strips a dev registration via an extra marker (path lacks 'betterdb')", () => {
    const hooksDir = "/Users/x/dev/memory/src/hooks";
    const hooks = {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `bash -c 'bun run "${hooksDir}/session-end.ts"'`,
            },
          ],
        },
        { hooks: [{ type: "command", command: "/other/tool/hook" }] },
      ],
    };
    const result = stripLegacyBetterdbHooks(hooks, ["betterdb", hooksDir]);
    expect(result["Stop"]).toHaveLength(1);
    expect(JSON.stringify(result["Stop"])).toContain("/other/tool/hook");
  });

  test("ignores empty markers so they cannot match everything", () => {
    const hooks = {
      Stop: [{ hooks: [{ type: "command", command: "/other/tool/hook" }] }],
    };
    const result = stripLegacyBetterdbHooks(hooks, [""]);
    expect(result["Stop"]).toHaveLength(1);
  });

  test("does not mutate its input", () => {
    const hooks = {
      Stop: [
        {
          hooks: [
            { type: "command", command: "/Users/x/.betterdb/bin/session-end" },
          ],
        },
      ],
    };
    stripLegacyBetterdbHooks(hooks);
    expect(hooks["Stop"]).toHaveLength(1);
  });
});
