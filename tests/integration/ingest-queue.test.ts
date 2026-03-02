import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import Redis from "iovalkey";
import { ValkeyClient } from "../../src/client/valkey.js";
import { config } from "../../src/config.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";

describe.skipIf(SKIP)("Ingest queue", () => {
  let client: ValkeyClient;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(config.valkey.url, { lazyConnect: true });
    await redis.connect();
    client = new ValkeyClient(redis);
  });

  afterAll(async () => {
    // Clean up queue keys
    await redis.del("betterdb:ingest_queue");
    await redis.quit();
  });

  test("queues transcript when Ollama unavailable", async () => {
    const transcript = "This is a test transcript with sufficient length to pass minimum threshold checks for processing and storage in the memory system.";
    const meta = {
      project: "test",
      branch: "main",
      timestamp: new Date().toISOString(),
      sessionId: "test-session-1",
    };

    await client.pushIngestQueue(transcript, meta);

    const items = await client.popIngestQueue(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.transcript).toBe(transcript);
    expect(items[0]!.meta["project"]).toBe("test");
  });

  test("handles multiple queued items", async () => {
    await client.pushIngestQueue("transcript-1", { session: "s1" });
    await client.pushIngestQueue("transcript-2", { session: "s2" });
    await client.pushIngestQueue("transcript-3", { session: "s3" });

    const batch = await client.popIngestQueue(2);
    expect(batch).toHaveLength(2);
    expect(batch[0]!.transcript).toBe("transcript-1");
    expect(batch[1]!.transcript).toBe("transcript-2");

    // Remaining item
    const remaining = await client.popIngestQueue(5);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.transcript).toBe("transcript-3");
  });

  test("returns empty array when queue is empty", async () => {
    const items = await client.popIngestQueue(10);
    expect(items).toEqual([]);
  });

  test("preserves complex metadata", async () => {
    const complexMeta = {
      project: "complex-test",
      branch: "feature/memory",
      nestedData: { key: "value" },
      arrayData: [1, 2, 3],
    };

    await client.pushIngestQueue("test-transcript", complexMeta);
    const items = await client.popIngestQueue(1);

    expect(items[0]!.meta).toEqual(complexMeta);
  });
});
