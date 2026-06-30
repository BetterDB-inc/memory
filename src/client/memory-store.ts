import {
  MemoryStore,
  type ConsolidateOptions,
  type ConsolidateResult,
  type EmbedFn,
  type MemoryItem,
  type MemoryStoreClient,
} from "@betterdb/agent-memory";
import {
  EpisodicMemorySchema,
  type EpisodicMemory,
} from "../memory/schema.js";
import { getValkeyClient } from "./valkey.js";

// Store name fixes the index (`betterdb:mem:idx`) and key prefix
// (`betterdb:mem:{id}`) that @betterdb/agent-memory derives internally.
const STORE_NAME = "betterdb";

// --- EpisodicMemory <-> MemoryItem mapping ---
//
// agent-memory's MemoryItem is flat (content + importance + tags + scope),
// while the plugin's EpisodicMemory carries a structured `summary` plus
// `branch` and an original `timestamp`. We embed `summary.oneLineSummary`
// (so recall quality matches the current implementation, which embeds the
// same string) and stash everything MemoryItem can't hold natively in the
// free-form `source` field. The remaining fields map directly:
//   project        -> namespace
//   importanceScore -> importance
//   accessCount     -> accessCount   (tracked natively, bumped on recall)
//   lastAccessed    -> lastAccessedAt (tracked natively)

interface SourcePayload {
  summary: EpisodicMemory["summary"];
  branch: string;
  timestamp: string;
}

export function episodicToSource(memory: EpisodicMemory): string {
  const payload: SourcePayload = {
    summary: memory.summary,
    branch: memory.branch,
    timestamp: memory.timestamp,
  };
  return JSON.stringify(payload);
}

export function itemToEpisodic(item: MemoryItem): EpisodicMemory | null {
  let summary: EpisodicMemory["summary"];
  let branch: string;
  let timestamp: string;

  const payload = parseSourcePayload(item.source);
  if (payload) {
    summary = payload.summary;
    branch = payload.branch;
    timestamp = payload.timestamp;
  } else {
    // A flat item with no SourcePayload — e.g. a memory produced by
    // MemoryStore.consolidate(), whose `source` is its own marker, not our
    // JSON. Synthesize a minimal episodic memory from the content so merged
    // summaries stay first-class for recall, listing, and injection.
    summary = {
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: item.content,
    };
    branch = "consolidated";
    timestamp = new Date(item.createdAt).toISOString();
  }

  const parsed = EpisodicMemorySchema.safeParse({
    memoryId: item.id,
    project: item.namespace ?? "unknown",
    branch,
    timestamp,
    summary,
    importanceScore: item.importance,
    accessCount: item.accessCount,
    lastAccessed: new Date(item.lastAccessedAt).toISOString(),
  });

  return parsed.success ? parsed.data : null;
}

function parseSourcePayload(source: string | undefined): SourcePayload | null {
  if (!source) return null;
  try {
    const parsed = JSON.parse(source) as Partial<SourcePayload>;
    if (parsed && typeof parsed === "object" && parsed.summary) {
      return parsed as SourcePayload;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Adapter ---
//
// Drop-in replacement for the episodic-vector subset of ValkeyClient, backed
// by @betterdb/agent-memory's MemoryStore. Knowledge entries and work queues
// stay on the existing ValkeyClient — they have no MemoryStore analog.
export class PluginMemoryStore {
  private readonly store: MemoryStore;

  constructor(client: MemoryStoreClient, embed?: EmbedFn) {
    this.store = new MemoryStore({
      client,
      name: STORE_NAME,
      embedFn: embed,
      // The plugin owns its own analytics/discovery story; keep the store quiet
      // and offline so it pulls in no posthog/otel network behavior.
      discovery: false,
      configRefresh: false,
      analytics: { disabled: true },
    });
  }

  /** Create the `betterdb:mem:idx` vector index if absent (idempotent). */
  ensureIndex(): Promise<void> {
    return this.store.ensureIndex();
  }

  /**
   * Store an episodic memory and return its generated id. The vector is
   * derived from `summary.oneLineSummary` inside MemoryStore — callers no
   * longer precompute an embedding.
   */
  storeMemory(memory: EpisodicMemory): Promise<string> {
    return this.store.remember(memory.summary.oneLineSummary, {
      importance: memory.importanceScore,
      namespace: memory.project,
      source: episodicToSource(memory),
    });
  }

  /**
   * KNN recall scoped to `project`, ranked by MemoryStore's composite score
   * (similarity + recency + importance). Recalled memories are reinforced
   * automatically. Embeds `query` internally.
   */
  async recall(
    query: string,
    project: string,
    topK: number,
  ): Promise<EpisodicMemory[]> {
    const hits = await this.store.recall(query, { namespace: project, k: topK });
    return hits
      .map((hit) => itemToEpisodic(hit.item))
      .filter((m): m is EpisodicMemory => m !== null);
  }

  /** KNN recall from a precomputed embedding (see {@link recall}). */
  async searchMemories(
    embedding: number[],
    project: string,
    topK: number,
  ): Promise<EpisodicMemory[]> {
    const hits = await this.store.recallByVector(embedding, {
      namespace: project,
      k: topK,
    });
    return hits
      .map((hit) => itemToEpisodic(hit.item))
      .filter((m): m is EpisodicMemory => m !== null);
  }

  /**
   * List stored memories, optionally scoped to `project` and filtered by a
   * minimum importance. Paginates through MemoryStore.list so callers that
   * scan all memories (open-thread aggregation, distillation) get the full set.
   * Pass `max` to stop early once that many matches are collected, so callers
   * that only need a bounded slice don't materialize the whole store.
   */
  async listMemories(
    project?: string,
    minImportance?: number,
    max?: number,
  ): Promise<EpisodicMemory[]> {
    const out: EpisodicMemory[] = [];
    const limit = 100;
    let offset = 0;

    for (;;) {
      const { items, total } = await this.store.list({
        namespace: project,
        limit,
        offset,
      });
      if (items.length === 0) break;

      for (const item of items) {
        const memory = itemToEpisodic(item);
        if (!memory) continue;
        if (minImportance !== undefined && memory.importanceScore < minImportance) {
          continue;
        }
        out.push(memory);
        if (max !== undefined && out.length >= max) return out;
      }

      offset += items.length;
      if (offset >= total) break;
    }

    return out;
  }

  /**
   * Merge a selection of memories into one summary memory (and delete the
   * sources). Selection criteria — scope, age, or max importance — are passed
   * through to MemoryStore.consolidate.
   */
  consolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
    return this.store.consolidate(options);
  }

  async getMemory(memoryId: string): Promise<EpisodicMemory | null> {
    const item = await this.store.get(memoryId);
    return item ? itemToEpisodic(item) : null;
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.store.forget(memoryId);
  }

  close(): Promise<void> {
    return this.store.close();
  }
}

/**
 * Shared accessor for the episodic-vector store. Reuses the singleton
 * ValkeyClient's connection (its `.call()` satisfies MemoryStoreClient) so the
 * whole plugin runs on one iovalkey socket. Pass `embed` when the caller will
 * remember/recall/ensureIndex; read-only callers (list/get/delete) may omit it.
 */
export async function getPluginMemoryStore(
  embed?: EmbedFn,
): Promise<PluginMemoryStore> {
  const valkey = await getValkeyClient();
  return new PluginMemoryStore(valkey.redis, embed);
}
