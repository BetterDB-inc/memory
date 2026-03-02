import { config } from "../config.js";
import type { ModelClient } from "../client/model.js";
import type { ValkeyClient } from "../client/valkey.js";
import { SessionSummarySchema, type EpisodicMemory } from "./schema.js";
import { computeInitialImportance, SessionCapture } from "./capture.js";

// --- Cosine Similarity ---

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Aging Pipeline ---

export class AgingPipeline {
  private valkeyClient: ValkeyClient;
  private modelClient: ModelClient;

  constructor(valkeyClient: ValkeyClient, modelClient: ModelClient) {
    this.valkeyClient = valkeyClient;
    this.modelClient = modelClient;
  }

  // --- Decay ---

  async runDecay(
    project?: string,
  ): Promise<{ processed: number; flagged: number }> {
    const memoryIds = await this.valkeyClient.listMemoryIds(project);
    let processed = 0;
    let flagged = 0;

    for (const id of memoryIds) {
      const memory = await this.valkeyClient.getMemory(id);
      if (!memory) continue;

      const daysSince =
        (Date.now() - new Date(memory.lastAccessed).getTime()) /
        (1000 * 60 * 60 * 24);
      const newScore =
        memory.importanceScore *
        Math.pow(config.memory.decayRate, daysSince);

      await this.valkeyClient.updateImportance(id, newScore);
      processed++;

      if (newScore < config.memory.compressThreshold) {
        await this.valkeyClient.pushCompressQueue(id);
        flagged++;
      }
    }

    return { processed, flagged };
  }

  // --- Compression ---

  async runCompression(): Promise<{ merged: number; deleted: number }> {
    const ids = await this.valkeyClient.popCompressQueue(50);
    if (ids.length === 0) return { merged: 0, deleted: 0 };

    // Fetch memories with embeddings
    const entries: Array<{
      memory: EpisodicMemory;
      embedding: number[];
    }> = [];

    for (const id of ids) {
      const memory = await this.valkeyClient.getMemory(id);
      const embedding = await this.valkeyClient.getMemoryEmbedding(id);
      if (memory && embedding) {
        entries.push({ memory, embedding });
      }
    }

    // Group by project
    const byProject = new Map<
      string,
      Array<{ memory: EpisodicMemory; embedding: number[] }>
    >();
    for (const entry of entries) {
      const group = byProject.get(entry.memory.project) ?? [];
      group.push(entry);
      byProject.set(entry.memory.project, group);
    }

    let merged = 0;
    let deleted = 0;

    for (const [, group] of byProject) {
      // Batch size guard: only process 100 lowest-importance per project
      const sorted = group
        .sort((a, b) => a.memory.importanceScore - b.memory.importanceScore)
        .slice(0, 100);

      if (sorted.length < group.length) {
        console.error(
          `[betterdb] Project group exceeds 100 memories, processing only lowest-importance 100. Additional runs needed.`,
        );
      }

      // Find clusters of similar memories
      const used = new Set<number>();
      const clusters: Array<
        Array<{ memory: EpisodicMemory; embedding: number[] }>
      > = [];

      for (let i = 0; i < sorted.length; i++) {
        if (used.has(i)) continue;
        const cluster = [sorted[i]!];
        used.add(i);

        for (let j = i + 1; j < sorted.length; j++) {
          if (used.has(j)) continue;
          // Check if similar to all cluster members
          const similar = cluster.every(
            (c) =>
              cosineSimilarity(c.embedding, sorted[j]!.embedding) > 0.85,
          );
          if (similar) {
            cluster.push(sorted[j]!);
            used.add(j);
          }
        }

        clusters.push(cluster);
      }

      // Process clusters
      for (const cluster of clusters) {
        if (cluster.length >= 3) {
          // Merge cluster into a single memory
          const combinedTranscript = cluster
            .map(
              (c) =>
                `Session ${c.memory.memoryId}: ${c.memory.summary.oneLineSummary}\n` +
                `Decisions: ${c.memory.summary.decisions.join("; ")}\n` +
                `Patterns: ${c.memory.summary.patterns.join("; ")}`,
            )
            .join("\n\n");

          const mergedSummary =
            await this.modelClient.summarize(combinedTranscript);
          const mergedEmbedding = await this.modelClient.embed(
            mergedSummary.oneLineSummary,
          );

          const avgImportance =
            cluster.reduce((sum, c) => sum + c.memory.importanceScore, 0) /
            cluster.length;

          const newMemory: EpisodicMemory = {
            memoryId: crypto.randomUUID(),
            project: cluster[0]!.memory.project,
            branch: cluster[0]!.memory.branch,
            timestamp: new Date().toISOString(),
            summary: mergedSummary,
            importanceScore: avgImportance,
            accessCount: 0,
            lastAccessed: new Date().toISOString(),
          };

          await this.valkeyClient.storeMemory(newMemory, mergedEmbedding);

          // Delete originals
          for (const c of cluster) {
            await this.valkeyClient.deleteMemory(c.memory.memoryId);
          }

          merged += cluster.length;
        } else if (cluster.length === 1) {
          const m = cluster[0]!.memory;
          const daysSince =
            (Date.now() - new Date(m.lastAccessed).getTime()) /
            (1000 * 60 * 60 * 24);

          if (m.importanceScore < 0.05 && daysSince > 90) {
            await this.valkeyClient.deleteMemory(m.memoryId);
            deleted++;
          }
        }
      }
    }

    return { merged, deleted };
  }

  // --- Distillation ---

  async runDistillation(
    project: string,
  ): Promise<{ distilled: number }> {
    const memoryIds = await this.valkeyClient.listMemoryIds(project, 0.5);
    const memories: EpisodicMemory[] = [];

    for (const id of memoryIds) {
      const memory = await this.valkeyClient.getMemory(id);
      if (memory) memories.push(memory);
    }

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
        const embedding = await this.modelClient.embed(
          summary.oneLineSummary,
        );
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

        await this.valkeyClient.storeMemory(memory, embedding);
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

    const { processed, flagged } = await this.runDecay(project);
    console.error(
      `[betterdb] Decay: processed ${processed}, flagged ${flagged} for compression`,
    );

    const { merged, deleted } = await this.runCompression();
    console.error(
      `[betterdb] Compression: merged ${merged}, deleted ${deleted}`,
    );

    if (project) {
      const { distilled } = await this.runDistillation(project);
      console.error(`[betterdb] Distillation: distilled ${distilled} entries`);
    }

    await this.valkeyClient.setLastAgingRun(new Date());
    console.error("[betterdb] Aging pipeline complete.");
  }
}
