import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import Redis from "iovalkey";
import type { EmbedFn } from "@betterdb/agent-memory";
import { PluginMemoryStore } from "../../src/client/memory-store.js";
import { config } from "../../src/config.js";
import type { EpisodicMemory } from "../../src/memory/schema.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";

const EMBED_DIM = 16;

// Deterministic, provider-free embedding: same text always yields the same
// vector, so a memory stored from its oneLineSummary is found by re-embedding
// that summary. Cosine distance is scale-invariant, so no normalization needed.
const fakeEmbed: EmbedFn = async (text: string) => {
  const v = Array.from({ length: EMBED_DIM }, () => 0);
  for (let i = 0; i < text.length; i++) {
    const idx = i % EMBED_DIM;
    v[idx] = (v[idx] ?? 0) + text.charCodeAt(i);
  }
  // Guarantee a non-zero vector (FT.SEARCH cosine needs magnitude > 0).
  v[0] = (v[0] ?? 0) + 1;
  return v;
};

describe.skipIf(SKIP)("PluginMemoryStore integration", () => {
  let redis: Redis;
  let store: PluginMemoryStore;

  const makeMemory = (overrides: Partial<EpisodicMemory> = {}): EpisodicMemory => ({
    memoryId: crypto.randomUUID(),
    project: "adapter-test",
    branch: "main",
    timestamp: "2025-01-01T00:00:00.000Z",
    summary: {
      decisions: ["Use the adapter"],
      patterns: ["Dogfooding"],
      problemsSolved: [{ problem: "Duplication", resolution: "MemoryStore" }],
      openThreads: ["Wire into MCP"],
      filesChanged: ["/src/client/memory-store.ts"],
      oneLineSummary: `Adapter session ${crypto.randomUUID()}`,
    },
    importanceScore: 0.75,
    accessCount: 0,
    lastAccessed: "2025-01-02T00:00:00.000Z",
    ...overrides,
  });

  const recallVector = (memory: EpisodicMemory) =>
    fakeEmbed(memory.summary.oneLineSummary);

  beforeAll(async () => {
    redis = new Redis(config.valkey.url, { lazyConnect: true });
    await redis.connect();
    await redis.call("FT.DROPINDEX", "betterdb:mem:idx").catch(() => {});
    store = new PluginMemoryStore(redis, fakeEmbed);
    await store.ensureIndex();
  });

  afterAll(async () => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "betterdb:*", "COUNT", "100");
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
    await redis.call("FT.DROPINDEX", "betterdb:mem:idx").catch(() => {});
    await store.close();
    await redis.quit();
  });

  test("ensureIndex is idempotent", async () => {
    await store.ensureIndex();
    await store.ensureIndex(); // must not throw
  });

  test("store and retrieve preserves the structured summary", async () => {
    const memory = makeMemory();
    const id = await store.storeMemory(memory);

    const retrieved = await store.getMemory(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.memoryId).toBe(id);
    expect(retrieved!.project).toBe("adapter-test");
    expect(retrieved!.branch).toBe("main");
    expect(retrieved!.timestamp).toBe("2025-01-01T00:00:00.000Z");
    expect(retrieved!.summary).toEqual(memory.summary);
  });

  test("getMemory returns null for a missing id", async () => {
    expect(await store.getMemory(crypto.randomUUID())).toBeNull();
  });

  test("searchMemories finds the stored memory via KNN", async () => {
    const memory = makeMemory({ project: "search-test" });
    const id = await store.storeMemory(memory);

    const results = await store.searchMemories(await recallVector(memory), "search-test", 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find((r) => r.memoryId === id);
    expect(hit).toBeDefined();
    expect(hit!.summary.oneLineSummary).toBe(memory.summary.oneLineSummary);
  });

  test("searchMemories is scoped to the project namespace", async () => {
    const memory = makeMemory({ project: "scope-a" });
    await store.storeMemory(memory);

    const otherScope = await store.searchMemories(await recallVector(memory), "scope-b", 5);
    expect(otherScope.some((r) => r.memoryId === memory.memoryId)).toBe(false);
  });

  test("recall reinforces access count", async () => {
    const memory = makeMemory({ project: "reinforce-test" });
    const id = await store.storeMemory(memory);

    await store.searchMemories(await recallVector(memory), "reinforce-test", 5);

    const after = await store.getMemory(id);
    expect(after!.accessCount).toBeGreaterThanOrEqual(1);
  });

  test("deleteMemory removes the memory", async () => {
    const memory = makeMemory();
    const id = await store.storeMemory(memory);

    await store.deleteMemory(id);
    expect(await store.getMemory(id)).toBeNull();
  });

  test("listMemories is scoped to project and filtered by importance", async () => {
    const highId = await store.storeMemory(
      makeMemory({ project: "list-test", importanceScore: 0.9 }),
    );
    const lowId = await store.storeMemory(
      makeMemory({ project: "list-test", importanceScore: 0.2 }),
    );

    const all = await store.listMemories("list-test");
    const ids = all.map((m) => m.memoryId);
    expect(ids).toContain(highId);
    expect(ids).toContain(lowId);

    const important = await store.listMemories("list-test", 0.5);
    const importantIds = important.map((m) => m.memoryId);
    expect(importantIds).toContain(highId);
    expect(importantIds).not.toContain(lowId);
  });

  test("consolidate merges low-importance memories into a readable summary", async () => {
    const project = "consolidate-test";
    for (let i = 0; i < 3; i++) {
      await store.storeMemory(makeMemory({ project, importanceScore: 0.15 }));
    }

    const result = await store.consolidate({
      namespace: project,
      maxImportance: 0.3,
      summarize: async () => "Consolidated summary of three sessions",
    });

    expect(result.consolidated).toBe(3);
    expect(result.created).toHaveLength(1);
    expect(result.deleted).toBe(3);

    const summary = await store.getMemory(result.created[0]!);
    expect(summary).not.toBeNull();
    expect(summary!.summary.oneLineSummary).toBe(
      "Consolidated summary of three sessions",
    );
    expect(summary!.branch).toBe("consolidated");
  });
});
