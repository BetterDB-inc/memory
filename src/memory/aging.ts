import type { MemoryItem } from "@betterdb/agent-memory";
import { config } from "../config.js";
import type { ModelClient } from "../client/model.js";
import type { ValkeyClient } from "../client/valkey.js";
import {
  itemToEpisodic,
  type PluginMemoryStore,
} from "../client/memory-store.js";
import type { EpisodicMemory } from "./schema.js";
import { computeInitialImportance } from "./capture.js";

// --- Aging Pipeline ---
//
// Recency decay and similarity clustering used to live here as bespoke code;
// both are now provided by @betterdb/agent-memory's MemoryStore — composite
// recall scoring handles recency at query time, and consolidate() merges a
// scope's low-value memories into a single summary. What remains here is the
// plugin-specific glue: ingest-queue processing, LLM-driven consolidation
// summarization, and pattern distillation into KnowledgeEntries.
//
// Consolidation only runs when a project has at least this many low-importance
// memories, so a lone low-value memory isn't pointlessly re-summarized (which
// would discard its structured summary and reset its access stats).
const CONSOLIDATE_MIN_CANDIDATES = 3;

export class AgingPipeline {
  private valkeyClient: ValkeyClient;
  private store: PluginMemoryStore;
  private modelClient: ModelClient;

  constructor(
    valkeyClient: ValkeyClient,
    store: PluginMemoryStore,
    modelClient: ModelClient,
  ) {
    this.valkeyClient = valkeyClient;
    this.store = store;
    this.modelClient = modelClient;
  }

  // --- Consolidation ---

  async runConsolidation(
    project: string,
  ): Promise<{ consolidated: number; created: number; deleted: number }> {
    const threshold = config.memory.compressThreshold;
    const candidates = (await this.store.listMemories(project)).filter(
      (m) => m.importanceScore <= threshold,
    );

    if (candidates.length < CONSOLIDATE_MIN_CANDIDATES) {
      return { consolidated: 0, created: 0, deleted: 0 };
    }

    const result = await this.store.consolidate({
      namespace: project,
      maxImportance: threshold,
      summaryImportance: threshold,
      summarize: (items) => this.summarizeCluster(items),
    });

    return {
      consolidated: result.consolidated,
      created: result.created.length,
      deleted: result.deleted,
    };
  }

  private async summarizeCluster(items: MemoryItem[]): Promise<string> {
    const transcript = items
      .map((item) => {
        const memory = itemToEpisodic(item);
        if (!memory) return item.content;
        return (
          `Session: ${memory.summary.oneLineSummary}\n` +
          `Decisions: ${memory.summary.decisions.map((d) => d.text).join("; ")}\n` +
          `Patterns: ${memory.summary.patterns.join("; ")}`
        );
      })
      .join("\n\n");

    const summary = await this.modelClient.summarize(transcript);
    return summary.oneLineSummary;
  }

  // --- Distillation ---

  async runDistillation(
    project: string,
  ): Promise<{ distilled: number }> {
    const memories = await this.store.listMemories(project, 0.5);

    if (memories.length < config.memory.distillMinSessions) {
      return { distilled: 0 };
    }

    // Count pattern occurrences
    const patternCounts = new Map<string, string[]>();
    for (const m of memories) {
      for (const pattern of m.summary.patterns) {
        const normalized = pattern.toLowerCase().trim();
        const sources = patternCounts.get(normalized) ?? [];
        sources.push(m.memoryId);
        patternCounts.set(normalized, sources);
      }
    }

    let distilled = 0;

    for (const [pattern, sourceIds] of patternCounts) {
      if (sourceIds.length < config.memory.distillMinSessions) continue;

      const distillPrompt = `Distill this recurring pattern into a single factual sentence:\nPattern: "${pattern}"\nAppeared in ${sourceIds.length} sessions.`;
      const summary = await this.modelClient.summarize(distillPrompt);

      const entry = {
        entryId: crypto.randomUUID(),
        project,
        topic: pattern.slice(0, 100),
        fact: summary.oneLineSummary,
        confidence: Math.min(0.5 + sourceIds.length * 0.1, 1.0),
        sourceMemoryIds: sourceIds.slice(0, 10),
        lastUpdated: new Date().toISOString(),
        accessCount: 0,
      };

      await this.valkeyClient.storeKnowledge(entry);
      distilled++;
    }

    return { distilled };
  }

  // --- Ingest Queue Processing ---

  async processIngestQueue(): Promise<{ processed: number }> {
    const items = await this.valkeyClient.popIngestQueue(20);
    let processed = 0;

    for (const item of items) {
      try {
        const summary = await this.modelClient.summarize(item.transcript);
        const importance = computeInitialImportance(summary);

        const meta = item.meta as Record<string, string>;
        const memory: EpisodicMemory = {
          memoryId: crypto.randomUUID(),
          project: meta["project"] ?? "unknown",
          branch: meta["branch"] ?? "unknown",
          timestamp: meta["timestamp"] ?? new Date().toISOString(),
          summary,
          importanceScore: importance,
          accessCount: 0,
          lastAccessed: new Date().toISOString(),
        };

        await this.store.storeMemory(memory);
        processed++;
      } catch (err) {
        console.error("[betterdb] Failed to process queued transcript:", err);
        // Re-queue on failure
        await this.valkeyClient.pushIngestQueue(
          item.transcript,
          item.meta,
        );
        break;
      }
    }

    return { processed };
  }

  // --- Full Pipeline ---

  async runFullPipeline(project?: string): Promise<void> {
    console.error("[betterdb] Starting aging pipeline...");

    const { processed: ingested } = await this.processIngestQueue();
    console.error(`[betterdb] Ingest queue: processed ${ingested} items`);

    const projects = project
      ? [project]
      : await this.allProjects();

    for (const p of projects) {
      const { consolidated, created, deleted } = await this.runConsolidation(p);
      console.error(
        `[betterdb] Consolidation (${p}): merged ${consolidated} into ${created}, deleted ${deleted}`,
      );

      const { distilled } = await this.runDistillation(p);
      console.error(`[betterdb] Distillation (${p}): distilled ${distilled} entries`);
    }

    await this.valkeyClient.setLastAgingRun(new Date());
    console.error("[betterdb] Aging pipeline complete.");
  }

  private async allProjects(): Promise<string[]> {
    const memories = await this.store.listMemories();
    return [...new Set(memories.map((m) => m.project))];
  }
}
