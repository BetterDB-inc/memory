import { describe, expect, test } from "bun:test";
import { formatForInjection } from "../../src/memory/retrieval.js";
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

describe("formatForInjection", () => {
  test("returns empty string for no memories", () => {
    expect(formatForInjection([])).toBe("");
  });

  test("includes header with memory count", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("# BetterDB Session Context");
    expect(result).toContain("Retrieved 1 memories");
  });

  test("includes open threads inline", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("Open: Optimize queries");
  });

  test("includes decisions inline", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("Decision: Use TypeScript");
  });

  test("includes solved problems inline", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("Solved: Bug");
  });

  test("includes files section", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("## Files with History");
    expect(result).toContain("/src/db.ts");
  });

  test("includes session memories section", () => {
    const result = formatForInjection([makeMemory()]);
    expect(result).toContain("## Session Memories");
    expect(result).toContain("Test session");
  });

  test("deduplicates files across memories", () => {
    const m1 = makeMemory({
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: ["/src/db.ts"],
        oneLineSummary: "S1",
      },
    });
    const m2 = makeMemory({
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: ["/src/db.ts"],
        oneLineSummary: "S2",
      },
    });

    const result = formatForInjection([m1, m2]);
    const fileMatches = result.match(/\/src\/db\.ts/g);
    expect(fileMatches).toHaveLength(1);
  });

  test("limits files to 10 items", () => {
    const memory = makeMemory({
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: Array.from({ length: 15 }, (_, i) => `/src/file${i}.ts`),
        oneLineSummary: "Many files",
      },
    });
    const result = formatForInjection([memory]);
    const fileSection = result.split("## Files with History")[1] ?? "";
    const fileCount = (fileSection.match(/^- /gm) ?? []).length;
    expect(fileCount).toBe(10);
  });
});
