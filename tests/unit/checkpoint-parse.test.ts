import { describe, expect, test, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import { parseTurnsFrom } from "../../src/memory/checkpoint.js";

const FIXTURE = "/tmp/betterdb-parse-test.jsonl";

afterEach(async () => {
  await unlink(FIXTURE).catch(() => {});
});

async function writeLines(lines: object[]): Promise<void> {
  await Bun.write(FIXTURE, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("parseTurnsFrom", () => {
  test("returns [] for a missing file", async () => {
    expect(await parseTurnsFrom("/tmp/does-not-exist.jsonl", 0)).toEqual([]);
  });

  test("parses all turns from offset 0 with end-byte offsets", async () => {
    await writeLines([
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi" } },
    ]);
    const turns = await parseTurnsFrom(FIXTURE, 0);
    expect(turns.map((t) => t.text)).toEqual(["User: hello", "Assistant: hi"]);
    expect(turns[0]!.endByte).toBeGreaterThan(0);
    expect(turns[1]!.endByte).toBeGreaterThan(turns[0]!.endByte);
  });

  test("resuming from a prior endByte yields only later turns", async () => {
    await writeLines([
      { type: "user", message: { content: "first" } },
      { type: "user", message: { content: "second" } },
    ]);
    const all = await parseTurnsFrom(FIXTURE, 0);
    const resumed = await parseTurnsFrom(FIXTURE, all[0]!.endByte);
    expect(resumed.map((t) => t.text)).toEqual(["User: second"]);
  });

  test("the final endByte equals the file size", async () => {
    await writeLines([{ type: "user", message: { content: "only" } }]);
    const size = Bun.file(FIXTURE).size;
    const turns = await parseTurnsFrom(FIXTURE, 0);
    expect(turns[turns.length - 1]!.endByte).toBe(size);
  });

  test("final endByte equals file size when no trailing newline", async () => {
    await Bun.write(
      FIXTURE,
      JSON.stringify({ type: "user", message: { content: "no newline" } }),
    );
    const size = Bun.file(FIXTURE).size;
    const turns = await parseTurnsFrom(FIXTURE, 0);
    expect(turns).toHaveLength(1);
    expect(turns[turns.length - 1]!.endByte).toBe(size);
  });
});
