import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import Redis from "iovalkey";
import { ValkeyClient } from "../../src/client/valkey.js";
import { config } from "../../src/config.js";
import type { EpisodicMemory } from "../../src/memory/schema.js";
import { computeInitialImportance } from "../../src/memory/capture.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";

describe.skipIf(SKIP)("End-to-end pipeline", () => {
  let client: ValkeyClient;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(config.valkey.url, { lazyConnect: true });
    await redis.connect();
    client = new ValkeyClient(redis);
    await client.dropIndex();
    await client.ensureIndex(4);
  });

  afterAll(async () => {
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

  test("store → retrieve → decay cycle", async () => {
    // 1. Build a memory with a computed importance
    const summary = {
      decisions: ["Use Valkey"],
      patterns: ["Repository pattern"],
      problemsSolved: [{ problem: "Slow queries", resolution: "Added index" }],
      openThreads: ["Consider caching"],
      filesChanged: ["/src/db.ts", "/src/queries.ts"],
      oneLineSummary: "Set up database layer with Valkey",
    };

    const importance = computeInitialImportance(summary);
    expect(importance).toBeGreaterThan(0.3); // Should be higher than baseline

    // 2. Store the memory
    const memory: EpisodicMemory = {
      memoryId: crypto.randomUUID(),
      project: "pipeline-test",
      branch: "main",
      timestamp: new Date().toISOString(),
      summary,
      importanceScore: importance,
      accessCount: 0,
      lastAccessed: new Date().toISOString(),
    };

    const embedding = [0.5, 0.5, 0.3, 0.1];
    await client.storeMemory(memory, embedding);

    // 3. Retrieve and verify content
    const retrieved = await client.getMemory(memory.memoryId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.summary.oneLineSummary).toBe("Set up database layer with Valkey");
    expect(retrieved!.importanceScore).toBe(importance);

    // 4. Simulate decay (manual score reduction)
    const decayedScore = importance * Math.pow(config.memory.decayRate, 10); // 10 days
    await client.updateImportance(memory.memoryId, decayedScore);

    const afterDecay = await client.getMemory(memory.memoryId);
    expect(afterDecay!.importanceScore).toBeLessThan(importance);
    expect(afterDecay!.importanceScore).toBeCloseTo(decayedScore, 4);
  });

  test("KNN search returns expected memory by vector similarity", async () => {
    const m1: EpisodicMemory = {
      memoryId: crypto.randomUUID(),
      project: "knn-test",
      branch: "main",
      timestamp: new Date().toISOString(),
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: [],
        oneLineSummary: "Database work",
      },
      importanceScore: 0.8,
      accessCount: 0,
      lastAccessed: new Date().toISOString(),
    };

    const m2: EpisodicMemory = {
      memoryId: crypto.randomUUID(),
      project: "knn-test",
      branch: "main",
      timestamp: new Date().toISOString(),
      summary: {
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: [],
        oneLineSummary: "UI styling",
      },
      importanceScore: 0.6,
      accessCount: 0,
      lastAccessed: new Date().toISOString(),
    };

    // Store with distinct embeddings
    await client.storeMemory(m1, [1.0, 0.0, 0.0, 0.0]);
    await client.storeMemory(m2, [0.0, 0.0, 0.0, 1.0]);

    // Query close to m1's embedding
    const results = await client.searchMemories([0.9, 0.1, 0.0, 0.0], "knn-test", 2);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // First result should be m1 (closest to query)
    expect(results[0]!.memoryId).toBe(m1.memoryId);
  });
});
