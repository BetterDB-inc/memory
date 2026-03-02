import { describe, expect, test } from "bun:test";
import {
  SessionCapture,
  computeInitialImportance,
  getCwdProject,
} from "../../src/memory/capture.js";
import type { SessionEvent, SessionSummary } from "../../src/memory/schema.js";

describe("SessionCapture", () => {
  test("builds transcript from events", () => {
    const capture = new SessionCapture();
    const event: SessionEvent = {
      sessionId: "test-session",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "tool_call",
      content: "Bash: ls -la",
    };
    capture.addEvent(event);

    const transcript = capture.buildTranscript();
    expect(transcript).toContain("tool_call");
    expect(transcript).toContain("Bash: ls -la");
    expect(transcript).toContain("2025-01-01T00:00:00.000Z");
  });

  test("includes file path in transcript", () => {
    const capture = new SessionCapture();
    capture.addEvent({
      sessionId: "s1",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "file_change",
      content: "modified",
      filePath: "/src/index.ts",
    });

    const transcript = capture.buildTranscript();
    expect(transcript).toContain("[/src/index.ts]");
  });

  test("handles empty events", () => {
    const capture = new SessionCapture();
    expect(capture.buildTranscript()).toBe("");
    expect(capture.eventCount).toBe(0);
  });

  test("tracks event count", () => {
    const capture = new SessionCapture();
    capture.addEvent({
      sessionId: "s1",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "tool_call",
      content: "test1",
    });
    capture.addEvent({
      sessionId: "s1",
      timestamp: "2025-01-01T00:00:01.000Z",
      eventType: "tool_result",
      content: "test2",
    });
    expect(capture.eventCount).toBe(2);
  });
});

describe("computeInitialImportance", () => {
  test("returns baseline for empty summary", () => {
    const summary: SessionSummary = {
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: "Empty session",
    };
    expect(computeInitialImportance(summary)).toBe(0.3);
  });

  test("increases score for problems solved", () => {
    const summary: SessionSummary = {
      decisions: [],
      patterns: [],
      problemsSolved: [
        { problem: "Bug", resolution: "Fixed" },
        { problem: "Performance", resolution: "Optimized" },
      ],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: "Fixed bugs",
    };
    expect(computeInitialImportance(summary)).toBe(0.6);
  });

  test("caps at 1.0", () => {
    const summary: SessionSummary = {
      decisions: Array(10).fill("d"),
      patterns: Array(5).fill("p"),
      problemsSolved: [
        { problem: "a", resolution: "b" },
        { problem: "c", resolution: "d" },
      ],
      openThreads: ["thread"],
      filesChanged: Array(20).fill("f"),
      oneLineSummary: "Massive session",
    };
    expect(computeInitialImportance(summary)).toBeLessThanOrEqual(1.0);
  });

  test("open threads add 0.1", () => {
    const base: SessionSummary = {
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: "test",
    };
    const withThreads = { ...base, openThreads: ["thread1"] };

    expect(computeInitialImportance(withThreads)).toBe(
      computeInitialImportance(base) + 0.1,
    );
  });

  test("patterns add 0.05", () => {
    const base: SessionSummary = {
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: "test",
    };
    const withPatterns = { ...base, patterns: ["factory pattern"] };

    expect(computeInitialImportance(withPatterns)).toBe(
      computeInitialImportance(base) + 0.05,
    );
  });
});

describe("getCwdProject", () => {
  test("returns last segment of cwd", () => {
    const project = getCwdProject();
    expect(typeof project).toBe("string");
    expect(project.length).toBeGreaterThan(0);
  });
});
