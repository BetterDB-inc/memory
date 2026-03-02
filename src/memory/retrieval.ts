import { config } from "../config.js";
import type { ModelClient } from "../client/model.js";
import type { ValkeyClient } from "../client/valkey.js";
import type { EpisodicMemory } from "./schema.js";
import { AgingPipeline } from "./aging.js";

// --- Memory Retriever ---

export class MemoryRetriever {
  private valkeyClient: ValkeyClient;
  private modelClient: ModelClient;
  private agingPipeline: AgingPipeline;

  constructor(valkeyClient: ValkeyClient, modelClient: ModelClient) {
    this.valkeyClient = valkeyClient;
    this.modelClient = modelClient;
    this.agingPipeline = new AgingPipeline(valkeyClient, modelClient);
  }

  async retrieve(
    queryContext: string,
    project: string,
  ): Promise<EpisodicMemory[]> {
    await this.maybeRunAging(project);

    const embedding = await this.modelClient.embed(queryContext);

    const topK = config.memory.maxContextMemories * 2;
    const candidates = await this.valkeyClient.searchMemories(
      embedding,
      project,
      topK,
    );

    const now = Date.now();
    const scored = candidates
      .filter((m) => m.importanceScore >= 0.1)
      .map((m) => {
        const daysSince =
          (now - new Date(m.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
        const recencyFactor = Math.pow(
          config.memory.decayRate,
          Math.max(daysSince, 0),
        );
        return {
          memory: m,
          score: m.importanceScore * recencyFactor,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, config.memory.maxContextMemories);

    // Fire-and-forget access increments
    for (const { memory } of scored) {
      this.valkeyClient.incrementAccess(memory.memoryId).catch(() => {});
    }

    return scored.map((s) => s.memory);
  }

  async maybeRunAging(project: string): Promise<void> {
    const lastRun = await this.valkeyClient.getLastAgingRun();
    const hoursAgo = lastRun
      ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60)
      : Infinity;

    if (hoursAgo >= config.memory.agingIntervalHours) {
      await this.agingPipeline.runDecay(project);
      await this.valkeyClient.setLastAgingRun(new Date());
    }
  }
}

// --- Format for Injection ---

export function formatForInjection(memories: EpisodicMemory[]): string {
  if (memories.length === 0) return "";

  const sections: string[] = [
    `# BetterDB Session Context`,
    `_Retrieved ${memories.length} memories. Auto-generated — do not edit._`,
  ];

  // Per-memory summaries — this is the most important section
  sections.push(`\n## Session Memories`);
  for (const m of memories) {
    const date = m.timestamp.split("T")[0];
    sections.push(`- **[${date}]** ${m.summary.oneLineSummary}`);
    for (const d of m.summary.decisions) {
      sections.push(`  - Decision: ${d}`);
    }
    for (const p of m.summary.problemsSolved) {
      sections.push(`  - Solved: ${p.problem} → ${p.resolution}`);
    }
    for (const t of m.summary.openThreads) {
      sections.push(`  - Open: ${t}`);
    }
  }

  // Aggregated files across all memories
  const files = new Set<string>();
  for (const m of memories) {
    for (const f of m.summary.filesChanged) files.add(f);
  }

  if (files.size > 0) {
    sections.push(
      `\n## Files with History`,
      ...[...files].slice(0, 10).map((f) => `- ${f}`),
    );
  }

  return sections.join("\n");
}
