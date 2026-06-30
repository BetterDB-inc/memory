import { describe, expect, test } from "bun:test";
import type { MemoryItem } from "@betterdb/agent-memory";
import {
  episodicToSource,
  itemToEpisodic,
} from "../../src/client/memory-store.js";
import type { EpisodicMemory } from "../../src/memory/schema.js";

const makeMemory = (overrides: Partial<EpisodicMemory> = {}): EpisodicMemory => ({
  memoryId: crypto.randomUUID(),
  project: "test",
  branch: "main",
  timestamp: "2025-01-01T00:00:00.000Z",
  summary: {
    decisions: ["Use TypeScript"],
    patterns: ["Factory pattern"],
    problemsSolved: [{ problem: "Bug", resolution: "Fixed" }],
    openThreads: ["Optimize queries"],
    filesChanged: ["/src/db.ts"],
    oneLineSummary: "Test session",
  },
  importanceScore: 0.7,
  accessCount: 1,
  lastAccessed: "2025-01-02T00:00:00.000Z",
  ...overrides,
});

// MemoryItem as MemoryStore would hand it back, given a memory stored via
// PluginMemoryStore.storeMemory (source = episodicToSource(memory)).
const makeItem = (
  memory: EpisodicMemory,
  overrides: Partial<MemoryItem> = {},
): MemoryItem => ({
  id: memory.memoryId,
  content: memory.summary.oneLineSummary,
  importance: memory.importanceScore,
  tags: [],
  source: episodicToSource(memory),
  createdAt: Date.parse(memory.timestamp),
  lastAccessedAt: Date.parse(memory.lastAccessed),
  accessCount: memory.accessCount,
  namespace: memory.project,
  ...overrides,
});

describe("episodicToSource / itemToEpisodic round-trip", () => {
  test("preserves the structured summary", () => {
    const memory = makeMemory();
    const restored = itemToEpisodic(makeItem(memory));
    expect(restored).not.toBeNull();
    expect(restored?.summary).toEqual(memory.summary);
  });

  test("preserves project, branch, and timestamp", () => {
    const memory = makeMemory({
      project: "valkey/memory",
      branch: "feat/adapter",
      timestamp: "2024-06-15T12:30:00.000Z",
    });
    const restored = itemToEpisodic(makeItem(memory));
    expect(restored?.project).toBe("valkey/memory");
    expect(restored?.branch).toBe("feat/adapter");
    expect(restored?.timestamp).toBe("2024-06-15T12:30:00.000Z");
  });

  test("preserves open threads needed by list_open_threads", () => {
    const memory = makeMemory({
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: ["Wire adapter into MCP", "Add migration script"],
        filesChanged: [],
        oneLineSummary: "Threads session",
      },
    });
    const restored = itemToEpisodic(makeItem(memory));
    expect(restored?.summary.openThreads).toEqual([
      "Wire adapter into MCP",
      "Add migration script",
    ]);
  });

  test("uses live importance and accessCount from the MemoryItem", () => {
    const memory = makeMemory({ importanceScore: 0.7, accessCount: 1 });
    // MemoryStore reinforced the item after the original store.
    const item = makeItem(memory, { importance: 0.42, accessCount: 5 });
    const restored = itemToEpisodic(item);
    expect(restored?.importanceScore).toBeCloseTo(0.42);
    expect(restored?.accessCount).toBe(5);
  });

  test("derives lastAccessed from the MemoryItem's lastAccessedAt", () => {
    const memory = makeMemory();
    const ts = Date.parse("2025-03-03T03:03:03.000Z");
    const restored = itemToEpisodic(makeItem(memory, { lastAccessedAt: ts }));
    expect(restored?.lastAccessed).toBe("2025-03-03T03:03:03.000Z");
  });

  test("falls back to 'unknown' project when namespace is absent", () => {
    const memory = makeMemory();
    const item = makeItem(memory);
    delete item.namespace;
    expect(itemToEpisodic(item)?.project).toBe("unknown");
  });

  test("synthesizes a flat memory when source is missing (e.g. a consolidate summary)", () => {
    const memory = makeMemory();
    const item = makeItem(memory, { content: "Merged summary of three sessions" });
    delete item.source;
    const restored = itemToEpisodic(item);
    expect(restored).not.toBeNull();
    expect(restored?.summary.oneLineSummary).toBe("Merged summary of three sessions");
    expect(restored?.branch).toBe("consolidated");
    expect(restored?.summary.decisions).toEqual([]);
  });

  test("synthesizes a flat memory when source is not valid JSON", () => {
    const memory = makeMemory();
    const item = makeItem(memory, { source: "summary", content: "Flat content" });
    const restored = itemToEpisodic(item);
    expect(restored).not.toBeNull();
    expect(restored?.summary.oneLineSummary).toBe("Flat content");
    expect(restored?.branch).toBe("consolidated");
  });

  test("returns null when the reconstructed memory fails schema validation", () => {
    const memory = makeMemory();
    // Corrupt the stashed payload so importanceScore ends up out of range.
    const item = makeItem(memory, { importance: 5 });
    expect(itemToEpisodic(item)).toBeNull();
  });
});
