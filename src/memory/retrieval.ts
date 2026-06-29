import type { EpisodicMemory } from "./schema.js";

// Recall (KNN + composite recency/importance scoring + access reinforcement)
// now lives in @betterdb/agent-memory's MemoryStore, reached via
// PluginMemoryStore.recall. This module keeps only the injection formatter.

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
