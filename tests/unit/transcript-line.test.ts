import { describe, expect, test } from "bun:test";
import { parseTranscriptLine } from "../../src/memory/transcript.js";

describe("parseTranscriptLine", () => {
  test("extracts a user turn from string content", () => {
    const line = JSON.stringify({ type: "user", message: { content: "hello" } });
    expect(parseTranscriptLine(line)).toEqual([{ role: "user", text: "User: hello" }]);
  });

  test("extracts a user turn from block content", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "hi there" }] },
    });
    expect(parseTranscriptLine(line)).toEqual([{ role: "user", text: "User: hi there" }]);
  });

  test("drops system-generated command messages", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: "<command-name>/foo</command-name>" },
    });
    expect(parseTranscriptLine(line)).toEqual([]);
  });

  test("caps an assistant turn at 2000 chars", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: "x".repeat(5000) },
    });
    const turns = parseTranscriptLine(line);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("Assistant: " + "x".repeat(2000));
  });

  test("extracts a tool turn by name", () => {
    const line = JSON.stringify({ type: "tool_use", tool_name: "Edit" });
    expect(parseTranscriptLine(line)).toEqual([{ role: "tool", text: "Tool: Edit" }]);
  });

  test("returns [] for malformed JSON", () => {
    expect(parseTranscriptLine("{not json")).toEqual([]);
  });

  test("returns [] for an unrecognized entry type", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "summary" }))).toEqual([]);
  });
});
