import {
  MemoryStore,
  similarityFromDistance,
  type ConsolidateOptions,
  type ConsolidateResult,
  type EmbedFn,
  type MemoryItem,
  type MemoryScope,
  type MemoryStats,
  type MemoryStoreClient,
} from "@betterdb/agent-memory";
import {
  EpisodicMemorySchema,
  type EpisodicMemory,
} from "../memory/schema.js";
import { getValkeyClient } from "./valkey.js";
import { config } from "../config.js";

const SECONDS_PER_DAY = 86400;

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

/** A recalled memory carrying its relevance and composite score for gating. */
export interface ScoredMemory {
  memory: EpisodicMemory;
  /** Cosine similarity to the query, 0..1 (higher = more relevant). */
  relevance: number;
  /** Composite recall score (similarity + recency + importance). */
  score: number;
}

export function episodicToSource(memory: EpisodicMemory): string {
  const payload: SourcePayload = {
    summary: memory.summary,
    branch: memory.branch,
    timestamp: memory.timestamp,
  };
  return JSON.stringify(payload);
}

/**
 * Content-type tags for a memory, derived from which summary sections it fills.
 * Stored natively (not in the opaque `source` blob) so recall can filter on
 * them — e.g. surface only decisions, or only unresolved open threads.
 */
export function memoryTags(memory: EpisodicMemory): string[] {
  const tags: string[] = [];
  if (memory.summary.decisions.length > 0) tags.push("decision");
  if (memory.summary.patterns.length > 0) tags.push("pattern");
  if (memory.summary.problemsSolved.length > 0) tags.push("problem");
  if (memory.summary.openThreads.length > 0) tags.push("open-thread");
  return tags;
}

/**
 * The text embedded for a memory. Previously only `oneLineSummary` was
 * embedded, so recall could never see the structured detail (decisions,
 * patterns, problems, open threads) — the single biggest recall-quality limit.
 * We fold those into the vector here. `filesChanged` is deliberately omitted:
 * bare file paths are generic and dominate the similarity band with noise.
 */
export function buildEmbedText(memory: EpisodicMemory): string {
  const s = memory.summary;
  const parts: string[] = [s.oneLineSummary];
  if (s.decisions.length > 0) parts.push(`Decisions: ${s.decisions.join("; ")}`);
  if (s.patterns.length > 0) parts.push(`Patterns: ${s.patterns.join("; ")}`);
  if (s.problemsSolved.length > 0) {
    const solved = s.problemsSolved
      .map((p) => `${p.problem} → ${p.resolution}`)
      .join("; ");
    parts.push(`Problems solved: ${solved}`);
  }
  if (s.openThreads.length > 0) {
    parts.push(`Open threads: ${s.openThreads.join("; ")}`);
  }
  return parts.join("\n");
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
      // Composite-score decay/blend from plugin config. This is the single
      // time-decay in the system (recency, applied at query time) — there is
      // no separate importance-aging pass. configRefresh:false keeps these
      // values fixed rather than letting a Valkey config key override them.
      halfLifeSeconds: config.recall.halfLifeDays * SECONDS_PER_DAY,
      weights: {
        similarity: config.recall.weightSimilarity,
        recency: config.recall.weightRecency,
        importance: config.recall.weightImportance,
      },
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
   * Store an episodic memory and return its generated id. The vector is derived
   * from {@link buildEmbedText} (summary + structured detail) inside
   * MemoryStore — callers no longer precompute an embedding. The full episodic
   * memory is preserved in `source` for reconstruction; the embed text only
   * shapes the vector.
   */
  storeMemory(memory: EpisodicMemory): Promise<string> {
    return this.store.remember(buildEmbedText(memory), {
      importance: memory.importanceScore,
      namespace: memory.project,
      // Branch as the native thread scope; content-type tags for filtered
      // recall. Both are queryable, unlike the free-form `source` payload.
      threadId: memory.branch,
      tags: memoryTags(memory),
      source: episodicToSource(memory),
    });
  }

  /**
   * KNN recall ranked by MemoryStore's composite score. Unlike the raw store,
   * this returns each memory *with* its relevance so callers can gate on it —
   * `relevance` is cosine similarity (0..1, higher = closer) derived from the
   * hit's raw distance; `score` is the composite (similarity + recency +
   * importance). Omit `project` to search across all namespaces; pass `branch`
   * to scope to a git branch (native thread) and `tags` to filter by
   * content type.
   */
  async recall(
    query: string,
    opts: {
      project?: string;
      branch?: string;
      tags?: string[];
      k: number;
      threshold?: number;
      reinforce?: boolean;
    },
  ): Promise<ScoredMemory[]> {
    const hits = await this.store.recall(query, {
      ...(opts.project !== undefined ? { namespace: opts.project } : {}),
      ...(opts.branch !== undefined ? { threadId: opts.branch } : {}),
      ...(opts.tags !== undefined && opts.tags.length > 0
        ? { tags: opts.tags }
        : {}),
      k: opts.k,
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      reinforce: opts.reinforce ?? true,
    });
    const out: ScoredMemory[] = [];
    for (const hit of hits) {
      const memory = itemToEpisodic(hit.item);
      if (memory) {
        out.push({
          memory,
          score: hit.score,
          relevance: similarityFromDistance(hit.similarity),
        });
      }
    }
    return out;
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
   * List memories matching a scope (project namespace, branch thread, and/or
   * content-type tags) using the SAME native index filter as
   * {@link forgetByScope} — so a `listByScope` preview is exactly the set a
   * `forgetByScope` with the same scope would delete. Unlike {@link listMemories}
   * (which filters summary-derived tags in memory), this queries native tags,
   * so memories stored before native tagging are matched identically by both.
   */
  async listByScope(scope: {
    project?: string;
    branch?: string;
    tags?: string[];
  }): Promise<EpisodicMemory[]> {
    const out: EpisodicMemory[] = [];
    const limit = 100;
    let offset = 0;

    for (;;) {
      const { items, total } = await this.store.list({
        ...(scope.project !== undefined ? { namespace: scope.project } : {}),
        ...(scope.branch !== undefined ? { threadId: scope.branch } : {}),
        ...(scope.tags !== undefined && scope.tags.length > 0
          ? { tags: scope.tags }
          : {}),
        limit,
        offset,
      });
      if (items.length === 0) break;

      for (const item of items) {
        const memory = itemToEpisodic(item);
        if (memory) out.push(memory);
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

  /**
   * Bulk-delete every memory matching a scope (project namespace, branch
   * thread, and/or tags). Returns the number deleted. At least one scope field
   * should be set — an empty scope would match the whole store.
   */
  forgetByScope(scope: {
    project?: string;
    branch?: string;
    tags?: string[];
  }): Promise<number> {
    const s: MemoryScope & { tags?: string[] } = {};
    if (scope.project !== undefined) s.namespace = scope.project;
    if (scope.branch !== undefined) s.threadId = scope.branch;
    if (scope.tags !== undefined && scope.tags.length > 0) s.tags = scope.tags;
    return this.store.forgetByScope(s);
  }

  /** Live store stats: item count, evictions, and active composite config. */
  stats(): Promise<MemoryStats> {
    return this.store.stats();
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
