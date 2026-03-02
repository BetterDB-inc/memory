import Redis from "iovalkey";
import { config } from "../config.js";
import {
  EpisodicMemorySchema,
  KnowledgeEntrySchema,
  type EpisodicMemory,
  type KnowledgeEntry,
} from "../memory/schema.js";

// --- Embedding Serialization ---

export function embeddingToBuffer(embedding: number[]): Buffer {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  embedding.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

export function bufferToEmbedding(buf: Buffer): number[] {
  return Array.from(
    { length: buf.length / 4 },
    (_, i) => buf.readFloatLE(i * 4),
  );
}

// --- Valkey Client ---

export class ValkeyClient {
  private client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  // --- Index Management ---

  async assertEmbedDim(expectedDim: number, providerLabel?: string): Promise<void> {
    const stored = await this.client.get("betterdb:meta:embedDim");
    const storedProvider = await this.client.get("betterdb:meta:embedProvider");
    if (stored === null) {
      await this.client.set("betterdb:meta:embedDim", String(expectedDim));
      if (providerLabel) {
        await this.client.set("betterdb:meta:embedProvider", providerLabel);
      }
      return;
    }
    if (Number(stored) !== expectedDim) {
      const storedLabel = storedProvider ? ` (${storedProvider})` : "";
      const currentLabel = providerLabel ? ` (${providerLabel})` : "";
      throw new Error(
        `Embedding dimension mismatch: index was built with dim=${stored}${storedLabel}, ` +
          `but current provider produces dim=${expectedDim}${currentLabel}. ` +
          `Run 'bun run migrate-embeddings' to re-embed all memories.`,
      );
    }
    // Update provider label if it changed but dim is the same
    if (providerLabel && providerLabel !== storedProvider) {
      await this.client.set("betterdb:meta:embedProvider", providerLabel);
    }
  }

  async ensureIndex(embedDim: number, providerLabel?: string): Promise<void> {
    await this.assertEmbedDim(embedDim, providerLabel);

    try {
      await this.client.call(
        "FT.CREATE",
        config.valkey.indexName,
        "ON",
        "HASH",
        "PREFIX",
        "1",
        "betterdb:memory:",
        "SCHEMA",
        "embedding",
        "VECTOR",
        "HNSW",
        "6",
        "TYPE",
        "FLOAT32",
        "DIM",
        String(embedDim),
        "DISTANCE_METRIC",
        "COSINE",
        "project",
        "TAG",
        "branch",
        "TAG",
        "oneLineSummary",
        "TAG",
        "importanceScore",
        "NUMERIC",
        "timestamp",
        "NUMERIC",
        "accessCount",
        "NUMERIC",
      );
    } catch (err: unknown) {
      const message = err instanceof Error
        ? err.message
        : String(err);
      if (message.includes("already exists")) {
        return;
      }
      throw err;
    }
  }

  async dropIndex(): Promise<void> {
    try {
      await this.client.call("FT.DROPINDEX", config.valkey.indexName);
    } catch {
      // Index may not exist
    }
  }

  // --- Memory CRUD ---

  async storeMemory(
    memory: EpisodicMemory,
    embedding: number[],
  ): Promise<string> {
    const key = `betterdb:memory:${memory.memoryId}`;
    const timestampNum = new Date(memory.timestamp).getTime();

    await this.client.hset(key, {
      memoryId: memory.memoryId,
      project: memory.project,
      branch: memory.branch,
      timestamp: String(timestampNum),
      summary: JSON.stringify(memory.summary),
      oneLineSummary: memory.summary.oneLineSummary,
      importanceScore: String(memory.importanceScore),
      accessCount: String(memory.accessCount),
      lastAccessed: memory.lastAccessed,
      embedding: embeddingToBuffer(embedding),
    });

    return memory.memoryId;
  }

  async getMemory(memoryId: string): Promise<EpisodicMemory | null> {
    const key = `betterdb:memory:${memoryId}`;
    const data = await this.client.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return this.parseMemoryHash(data);
  }

  async getMemoryEmbedding(memoryId: string): Promise<number[] | null> {
    const key = `betterdb:memory:${memoryId}`;
    const raw = await this.client.hgetBuffer(key, "embedding");
    if (!raw) return null;
    return bufferToEmbedding(raw);
  }

  async updateImportance(memoryId: string, score: number): Promise<void> {
    const key = `betterdb:memory:${memoryId}`;
    await this.client.hset(key, "importanceScore", String(score));
  }

  async incrementAccess(memoryId: string): Promise<void> {
    const key = `betterdb:memory:${memoryId}`;
    await this.client.hincrby(key, "accessCount", 1);
    await this.client.hset(key, "lastAccessed", new Date().toISOString());
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const key = `betterdb:memory:${memoryId}`;
    await this.client.del(key);
  }

  async listMemoryIds(
    project?: string,
    minImportance?: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        "MATCH",
        "betterdb:memory:*",
        "COUNT",
        "100",
      );
      cursor = nextCursor;

      for (const key of keys) {
        // Skip keys that don't look like memory content hashes
        const memoryId = key.replace("betterdb:memory:", "");
        if (!memoryId || memoryId.includes(":")) continue;

        if (project || minImportance !== undefined) {
          const data = await this.client.hmget(
            key,
            "project",
            "importanceScore",
          );
          const [proj, importance] = data;

          if (project && proj !== project) continue;
          if (
            minImportance !== undefined &&
            Number(importance ?? 0) < minImportance
          ) {
            continue;
          }
        }

        ids.push(memoryId);
      }
    } while (cursor !== "0");

    return ids;
  }

  // --- Search ---

  async searchMemories(
    embedding: number[],
    project: string,
    topK: number,
  ): Promise<EpisodicMemory[]> {
    const buf = embeddingToBuffer(embedding);

    const result = (await this.client.call(
      "FT.SEARCH",
      config.valkey.indexName,
      `@project:{${project.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}}=>[KNN ${topK} @embedding $vec AS score]`,
      "PARAMS",
      "2",
      "vec",
      buf,
      "DIALECT",
      "2",
    )) as unknown[];

    return this.parseSearchResults(result);
  }

  // --- Knowledge ---

  async storeKnowledge(entry: KnowledgeEntry): Promise<void> {
    const key = `betterdb:knowledge:${entry.project}:${entry.topic}`;
    await this.client.hset(key, {
      entryId: entry.entryId,
      project: entry.project,
      topic: entry.topic,
      fact: entry.fact,
      confidence: String(entry.confidence),
      sourceMemoryIds: JSON.stringify(entry.sourceMemoryIds),
      lastUpdated: entry.lastUpdated,
      accessCount: String(entry.accessCount),
    });

    await this.client.zadd(
      `betterdb:knowledge:${entry.project}:index`,
      Date.now(),
      entry.topic,
    );
  }

  async listKnowledge(project: string): Promise<KnowledgeEntry[]> {
    const topics = await this.client.zrevrange(
      `betterdb:knowledge:${project}:index`,
      0,
      -1,
    );

    const entries: KnowledgeEntry[] = [];
    for (const topic of topics) {
      const key = `betterdb:knowledge:${project}:${topic}`;
      const data = await this.client.hgetall(key);
      if (!data || Object.keys(data).length === 0) continue;

      const parsed = KnowledgeEntrySchema.safeParse({
        ...data,
        confidence: Number(data["confidence"] ?? 0),
        accessCount: Number(data["accessCount"] ?? 0),
        sourceMemoryIds: JSON.parse(data["sourceMemoryIds"] ?? "[]"),
      });

      if (parsed.success) {
        entries.push(parsed.data);
      }
    }

    return entries;
  }

  // --- Queues ---

  async pushCompressQueue(memoryId: string): Promise<void> {
    await this.client.rpush("betterdb:compress_queue", memoryId);
  }

  async popCompressQueue(count: number): Promise<string[]> {
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = await this.client.lpop("betterdb:compress_queue");
      if (!item) break;
      items.push(item);
    }
    return items;
  }

  async pushIngestQueue(
    rawTranscript: string,
    sessionMeta: object,
  ): Promise<void> {
    await this.client.rpush(
      "betterdb:ingest_queue",
      JSON.stringify({ transcript: rawTranscript, meta: sessionMeta }),
    );
  }

  async popIngestQueue(
    count: number,
  ): Promise<Array<{ transcript: string; meta: Record<string, unknown> }>> {
    const items: Array<{
      transcript: string;
      meta: Record<string, unknown>;
    }> = [];
    for (let i = 0; i < count; i++) {
      const raw = await this.client.lpop("betterdb:ingest_queue");
      if (!raw) break;
      items.push(JSON.parse(raw));
    }
    return items;
  }

  // --- Aging Metadata ---

  async getLastAgingRun(): Promise<Date | null> {
    const stored = await this.client.get("betterdb:meta:lastAgingRun");
    if (!stored) return null;
    return new Date(stored);
  }

  async setLastAgingRun(timestamp: Date): Promise<void> {
    await this.client.set(
      "betterdb:meta:lastAgingRun",
      timestamp.toISOString(),
    );
  }

  // --- Lifecycle ---

  async quit(): Promise<void> {
    await this.client.quit();
  }

  // --- Internal Helpers ---

  private parseMemoryHash(
    data: Record<string, string>,
  ): EpisodicMemory | null {
    try {
      const timestamp = data["timestamp"];
      const parsed = EpisodicMemorySchema.safeParse({
        memoryId: data["memoryId"],
        project: data["project"],
        branch: data["branch"],
        timestamp: timestamp
          ? new Date(Number(timestamp)).toISOString()
          : new Date().toISOString(),
        summary: JSON.parse(data["summary"] ?? "{}"),
        importanceScore: Number(data["importanceScore"] ?? 0),
        accessCount: Number(data["accessCount"] ?? 0),
        lastAccessed:
          data["lastAccessed"] ?? new Date().toISOString(),
      });

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private parseSearchResults(result: unknown[]): EpisodicMemory[] {
    if (!Array.isArray(result) || result.length < 1) return [];

    const totalCount = result[0] as number;
    if (totalCount === 0) return [];

    const memories: EpisodicMemory[] = [];

    // FT.SEARCH returns: [count, key1, [field1, val1, ...], key2, ...]
    for (let i = 1; i < result.length; i += 2) {
      const fields = result[i + 1] as string[] | undefined;
      if (!Array.isArray(fields)) continue;

      const data: Record<string, string> = {};
      for (let j = 0; j < fields.length; j += 2) {
        const key = fields[j];
        const val = fields[j + 1];
        if (typeof key === "string" && typeof val === "string") {
          data[key] = val;
        }
      }

      const memory = this.parseMemoryHash(data);
      if (memory) {
        memories.push(memory);
      }
    }

    return memories;
  }
}

// --- Singleton Factory ---

let clientInstance: ValkeyClient | null = null;

export async function getValkeyClient(): Promise<ValkeyClient> {
  if (clientInstance) return clientInstance;

  const retryDelays = [100, 500, 2000];
  let lastError: Error | null = null;

  for (const delay of retryDelays) {
    try {
      const redis = new Redis(config.valkey.url, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      await redis.connect();
      clientInstance = new ValkeyClient(redis);
      return clientInstance;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `Failed to connect to Valkey at ${config.valkey.url} after 3 attempts: ${lastError?.message}`,
  );
}

export function resetValkeyClient(): void {
  clientInstance = null;
}
