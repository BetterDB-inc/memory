import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import Redis from "iovalkey";
import { ValkeyClient, embeddingToBuffer, bufferToEmbedding } from "../../src/client/valkey.js";
import { config } from "../../src/config.js";
import type { EpisodicMemory, KnowledgeEntry } from "../../src/memory/schema.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";

describe.skipIf(SKIP)("ValkeyClient integration", () => {
  let client: ValkeyClient;
  let redis: Redis;
  const testPrefix = `betterdb:test:${Date.now()}:`;

  beforeAll(async () => {
    redis = new Redis(config.valkey.url, { lazyConnect: true });
    await redis.connect();
    client = new ValkeyClient(redis);
    // Clean leftover metadata from real setup-index runs so tests start fresh
    await redis.del("betterdb:meta:embedDim", "betterdb:meta:embedProvider");
    await client.dropIndex();
  });

  afterAll(async () => {
    // Cleanup test keys
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "betterdb:*", "COUNT", "100");
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");

    try {
      await client.dropIndex();
    } catch {}
    await redis.quit();
  });

  // --- Embedding helpers ---

  test("embeddingToBuffer and bufferToEmbedding roundtrip", () => {
    const embedding = [0.1, 0.2, 0.3, -0.5, 1.0];
    const buf = embeddingToBuffer(embedding);
    const recovered = bufferToEmbedding(buf);

    expect(recovered).toHaveLength(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      expect(recovered[i]).toBeCloseTo(embedding[i]!, 5);
    }
  });

  // --- Index ---

  test("ensureIndex is idempotent", async () => {
    await client.ensureIndex(4);
    await client.ensureIndex(4); // Should not throw
  });

  test("assertEmbedDim catches mismatch", async () => {
    await redis.set("betterdb:meta:embedDim", "1024");

    try {
      await client.assertEmbedDim(768);
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect((err as Error).message).toContain("Embedding dimension mismatch");
      expect((err as Error).message).toContain("1024");
      expect((err as Error).message).toContain("768");
    }

    // Reset for other tests
    await redis.del("betterdb:meta:embedDim");
  });

  // --- Memory CRUD ---

  const makeTestMemory = (id?: string): EpisodicMemory => ({
    memoryId: id ?? crypto.randomUUID(),
    project: "test-project",
    branch: "main",
    timestamp: new Date().toISOString(),
    summary: {
      decisions: ["Use TypeScript"],
      patterns: ["Factory pattern"],
      problemsSolved: [{ problem: "Connection", resolution: "Retry" }],
      openThreads: ["Optimize queries"],
      filesChanged: ["/src/db.ts"],
      oneLineSummary: "Test session — integration test",
    },
    importanceScore: 0.75,
    accessCount: 0,
    lastAccessed: new Date().toISOString(),
  });

  test("store and retrieve memory", async () => {
    const memory = makeTestMemory();
    const embedding = [0.1, 0.2, 0.3, 0.4];

    await client.storeMemory(memory, embedding);
    const retrieved = await client.getMemory(memory.memoryId);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.memoryId).toBe(memory.memoryId);
    expect(retrieved!.project).toBe("test-project");
    expect(retrieved!.summary.oneLineSummary).toBe("Test session — integration test");
  });

  test("getMemory returns null for non-existent", async () => {
    const result = await client.getMemory("non-existent-uuid");
    expect(result).toBeNull();
  });

  test("updateImportance changes score", async () => {
    const memory = makeTestMemory();
    await client.storeMemory(memory, [0.1, 0.2, 0.3, 0.4]);

    await client.updateImportance(memory.memoryId, 0.42);
    const updated = await client.getMemory(memory.memoryId);

    expect(updated!.importanceScore).toBeCloseTo(0.42, 2);
  });

  test("incrementAccess updates count and lastAccessed", async () => {
    const memory = makeTestMemory();
    await client.storeMemory(memory, [0.1, 0.2, 0.3, 0.4]);

    await client.incrementAccess(memory.memoryId);
    await client.incrementAccess(memory.memoryId);

    const updated = await client.getMemory(memory.memoryId);
    expect(updated!.accessCount).toBe(2);
  });

  test("deleteMemory removes memory", async () => {
    const memory = makeTestMemory();
    await client.storeMemory(memory, [0.1, 0.2, 0.3, 0.4]);

    await client.deleteMemory(memory.memoryId);
    const result = await client.getMemory(memory.memoryId);

    expect(result).toBeNull();
  });

  test("listMemoryIds returns stored memory IDs", async () => {
    const m1 = makeTestMemory();
    const m2 = makeTestMemory();
    await client.storeMemory(m1, [0.1, 0.2, 0.3, 0.4]);
    await client.storeMemory(m2, [0.5, 0.6, 0.7, 0.8]);

    const ids = await client.listMemoryIds();
    expect(ids).toContain(m1.memoryId);
    expect(ids).toContain(m2.memoryId);
  });

  // --- KNN Search ---

  test("searchMemories returns results via KNN", async () => {
    // This test requires the FT index to exist
    await client.dropIndex();
    await client.ensureIndex(4);

    const memory = makeTestMemory();
    memory.project = "search-test";
    await client.storeMemory(memory, [1.0, 0.0, 0.0, 0.0]);

    // Search with same vector — should find it
    const results = await client.searchMemories(
      [1.0, 0.0, 0.0, 0.0],
      "search-test",
      5,
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.memoryId === memory.memoryId)).toBe(true);
  });

  // --- Knowledge ---

  test("store and list knowledge entries", async () => {
    const entry: KnowledgeEntry = {
      entryId: crypto.randomUUID(),
      project: "test-project",
      topic: "caching",
      fact: "Use Redis for caching hot data",
      confidence: 0.85,
      sourceMemoryIds: [],
      lastUpdated: new Date().toISOString(),
      accessCount: 0,
    };

    await client.storeKnowledge(entry);
    const entries = await client.listKnowledge("test-project");

    expect(entries.some((e) => e.topic === "caching")).toBe(true);
  });

  // --- Queues ---

  test("compress queue push and pop", async () => {
    await client.pushCompressQueue("mem-1");
    await client.pushCompressQueue("mem-2");

    const items = await client.popCompressQueue(2);
    expect(items).toEqual(["mem-1", "mem-2"]);

    // Queue should be empty now
    const empty = await client.popCompressQueue(1);
    expect(empty).toEqual([]);
  });

  test("ingest queue push and pop", async () => {
    await client.pushIngestQueue("transcript text", {
      project: "test",
      branch: "main",
    });

    const items = await client.popIngestQueue(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.transcript).toBe("transcript text");
    expect(items[0]!.meta).toEqual({ project: "test", branch: "main" });
  });

  // --- Aging metadata ---

  test("get/set last aging run", async () => {
    const before = await client.getLastAgingRun();
    // Could be null on first run

    const now = new Date();
    await client.setLastAgingRun(now);

    const after = await client.getLastAgingRun();
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeCloseTo(now.getTime(), -3); // within 1 second
  });
});
