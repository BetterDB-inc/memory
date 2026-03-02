import { describe, expect, test } from "bun:test";
import {
  SessionEventSchema,
  SessionSummarySchema,
  EpisodicMemorySchema,
  KnowledgeEntrySchema,
  HookPayloadSchema,
  SessionStartPayload,
  StopPayload,
  PreToolUsePayload,
  PostToolUsePayload,
} from "../../src/memory/schema.js";

describe("SessionEventSchema", () => {
  test("parses valid event", () => {
    const result = SessionEventSchema.parse({
      sessionId: "abc-123",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "tool_call",
      content: "Bash: ls",
    });
    expect(result.sessionId).toBe("abc-123");
    expect(result.eventType).toBe("tool_call");
  });

  test("accepts optional filePath", () => {
    const result = SessionEventSchema.parse({
      sessionId: "abc-123",
      timestamp: "2025-01-01T00:00:00.000Z",
      eventType: "file_change",
      content: "modified",
      filePath: "/src/index.ts",
    });
    expect(result.filePath).toBe("/src/index.ts");
  });

  test("rejects invalid eventType", () => {
    expect(() =>
      SessionEventSchema.parse({
        sessionId: "abc",
        timestamp: "2025-01-01T00:00:00.000Z",
        eventType: "invalid",
        content: "test",
      }),
    ).toThrow();
  });
});

describe("SessionSummarySchema", () => {
  test("parses with all defaults", () => {
    const result = SessionSummarySchema.parse({});
    expect(result.decisions).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.problemsSolved).toEqual([]);
    expect(result.openThreads).toEqual([]);
    expect(result.filesChanged).toEqual([]);
    expect(result.oneLineSummary).toBe(
      "Session recorded — summary unavailable",
    );
  });

  test("parses full summary", () => {
    const result = SessionSummarySchema.parse({
      decisions: ["Use Valkey for storage"],
      patterns: ["Factory pattern"],
      problemsSolved: [{ problem: "Connection", resolution: "Retry logic" }],
      openThreads: ["Optimize queries"],
      filesChanged: ["/src/db.ts"],
      oneLineSummary: "Set up database layer",
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.problemsSolved[0]?.problem).toBe("Connection");
  });

  test("enforces max array lengths", () => {
    expect(() =>
      SessionSummarySchema.parse({
        decisions: Array(11).fill("d"),
      }),
    ).toThrow();
  });

  test("rejects problemsSolved with wrong shape", () => {
    expect(() =>
      SessionSummarySchema.parse({
        problemsSolved: [{ problem: "Missing resolution field" }],
      }),
    ).toThrow();
  });
});

describe("EpisodicMemorySchema", () => {
  const validMemory = {
    memoryId: "550e8400-e29b-41d4-a716-446655440000",
    project: "test-project",
    branch: "main",
    timestamp: "2025-01-01T00:00:00.000Z",
    summary: {},
    importanceScore: 0.75,
    accessCount: 3,
    lastAccessed: "2025-01-02T00:00:00.000Z",
  };

  test("parses valid memory", () => {
    const result = EpisodicMemorySchema.parse(validMemory);
    expect(result.memoryId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.importanceScore).toBe(0.75);
  });

  test("rejects importanceScore > 1", () => {
    expect(() =>
      EpisodicMemorySchema.parse({ ...validMemory, importanceScore: 1.5 }),
    ).toThrow();
  });

  test("rejects importanceScore < 0", () => {
    expect(() =>
      EpisodicMemorySchema.parse({ ...validMemory, importanceScore: -0.1 }),
    ).toThrow();
  });

  test("rejects negative accessCount", () => {
    expect(() =>
      EpisodicMemorySchema.parse({ ...validMemory, accessCount: -1 }),
    ).toThrow();
  });

  test("rejects non-UUID memoryId", () => {
    expect(() =>
      EpisodicMemorySchema.parse({ ...validMemory, memoryId: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("KnowledgeEntrySchema", () => {
  test("parses valid entry", () => {
    const result = KnowledgeEntrySchema.parse({
      entryId: "550e8400-e29b-41d4-a716-446655440000",
      project: "test",
      topic: "caching",
      fact: "Use Redis for caching",
      confidence: 0.9,
      sourceMemoryIds: [],
      lastUpdated: "2025-01-01T00:00:00.000Z",
      accessCount: 0,
    });
    expect(result.topic).toBe("caching");
    expect(result.confidence).toBe(0.9);
  });

  test("rejects confidence > 1", () => {
    expect(() =>
      KnowledgeEntrySchema.parse({
        entryId: "550e8400-e29b-41d4-a716-446655440000",
        project: "test",
        topic: "t",
        fact: "f",
        confidence: 1.5,
        sourceMemoryIds: [],
        lastUpdated: "2025-01-01T00:00:00.000Z",
        accessCount: 0,
      }),
    ).toThrow();
  });
});

describe("HookPayloadSchema (discriminated union)", () => {
  test("parses SessionStart payload", () => {
    const result = HookPayloadSchema.parse({
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(result.hook_event_name).toBe("SessionStart");
  });

  test("parses Stop payload", () => {
    const result = HookPayloadSchema.parse({
      session_id: "s1",
      hook_event_name: "Stop",
    });
    expect(result.hook_event_name).toBe("Stop");
  });

  test("parses PreToolUse payload", () => {
    const result = HookPayloadSchema.parse({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(result.hook_event_name).toBe("PreToolUse");
    if (result.hook_event_name === "PreToolUse") {
      expect(result.tool_name).toBe("Bash");
    }
  });

  test("parses PostToolUse payload", () => {
    const result = HookPayloadSchema.parse({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/src/foo.ts" },
      tool_result: "success",
    });
    expect(result.hook_event_name).toBe("PostToolUse");
  });

  test("rejects unknown hook_event_name", () => {
    expect(() =>
      HookPayloadSchema.parse({
        session_id: "s1",
        hook_event_name: "Unknown",
      }),
    ).toThrow();
  });

  test("includes optional transcript_path and cwd", () => {
    const result = SessionStartPayload.parse({
      session_id: "s1",
      hook_event_name: "SessionStart",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/home/user/project",
    });
    expect(result.transcript_path).toBe("/tmp/transcript.jsonl");
    expect(result.cwd).toBe("/home/user/project");
  });
});
