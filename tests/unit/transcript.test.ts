import { describe, expect, test } from "bun:test";
import { selectTranscript, type TranscriptTurn } from "../../src/memory/transcript.js";

const user = (text: string): TranscriptTurn => ({ role: "user", text: `User: ${text}` });
const assistant = (text: string): TranscriptTurn => ({
  role: "assistant",
  text: `Assistant: ${text}`,
});
const tool = (name: string): TranscriptTurn => ({ role: "tool", text: `Tool: ${name}` });

describe("selectTranscript", () => {
  test("a transcript that fits is returned verbatim", () => {
    const turns = [user("hello"), assistant("hi"), tool("Read")];
    expect(selectTranscript(turns, 1000)).toBe(
      "User: hello\nAssistant: hi\nTool: Read",
    );
  });

  test("tool lines are dropped before conversation turns", () => {
    const turns = [
      user("fix the bug"),
      ...Array.from({ length: 50 }, (_, i) => tool(`Bash-${i}`)),
      assistant("fixed it by patching the gate"),
    ];
    const out = selectTranscript(turns, 120);
    expect(out).toContain("User: fix the bug");
    expect(out).toContain("Assistant: fixed it by patching the gate");
    expect(out).toContain("[...]");
    expect(out).not.toContain("Tool: Bash-25");
  });

  test("user turns from the middle of a long session survive", () => {
    // The old head+tail slice dropped the middle wholesale; the selector must
    // keep a mid-session user turn even when surrounded by bulky noise.
    const padding = "x".repeat(400);
    const turns = [
      user("start"),
      ...Array.from({ length: 20 }, () => assistant(padding)),
      user("IMPORTANT-MIDDLE-DECISION approved"),
      ...Array.from({ length: 20 }, () => assistant(padding)),
      user("end"),
    ];
    const out = selectTranscript(turns, 2000);
    expect(out).toContain("IMPORTANT-MIDDLE-DECISION");
    expect(out).toContain("User: start");
    expect(out).toContain("User: end");
  });

  test("assistant turns adjacent to user turns outrank distant ones", () => {
    const filler = "y".repeat(150);
    const turns = [
      user("do the thing"),
      assistant("ADJACENT reply to the user"),
      assistant(filler),
      assistant(filler),
      assistant(filler),
      assistant(filler),
    ];
    const out = selectTranscript(turns, 100);
    expect(out).toContain("ADJACENT reply");
    expect(out).not.toContain(filler);
  });

  test("gap markers appear where turns were elided", () => {
    const turns = [
      user("a"),
      tool("Noise1".repeat(30)),
      user("b"),
    ];
    const out = selectTranscript(turns, 30);
    expect(out).toContain("User: a");
    expect(out).toContain("User: b");
    expect(out).toContain("[...]");
  });

  test("tool-only fallback transcripts are not emptied", () => {
    const turns = Array.from({ length: 100 }, (_, i) => tool(`Edit-${i}`));
    const out = selectTranscript(turns, 200);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("Tool: Edit-0");
  });

  test("falls back to head+tail when no whole turn fits the budget", () => {
    const turns = [tool("Z".repeat(500))];
    const out = selectTranscript(turns, 100);
    expect(out.length).toBeLessThanOrEqual(110);
    expect(out).toContain("[...]");
    expect(out.startsWith("Tool: Z")).toBe(true);
  });

  test("selected turns keep their original order", () => {
    const turns = [
      user("first"),
      tool("T".repeat(200)),
      assistant("second reply here"),
      user("third"),
    ];
    const out = selectTranscript(turns, 80);
    const first = out.indexOf("User: first");
    const second = out.indexOf("Assistant: second reply here");
    const third = out.indexOf("User: third");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
