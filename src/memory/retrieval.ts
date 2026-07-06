import type { Decision, EpisodicMemory } from "./schema.js";
import type { RecallResult } from "./recall.js";

/** "Decision:" for made decisions; "Decision (proposed):" etc. otherwise, so
 * readers never mistake a discussed option for something that was done. */
function decisionLabel(d: Decision): string {
  return d.status === "done" ? "Decision" : `Decision (${d.status})`;
}

// Recall (KNN + composite recency/importance scoring + access reinforcement)
// now lives in @betterdb/agent-memory's MemoryStore, reached via
// PluginMemoryStore.recall. This module keeps only the formatters.

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
      sections.push(`  - ${decisionLabel(d)}: ${d.text}`);
    }
    for (const pat of m.summary.patterns) {
      sections.push(`  - Pattern: ${pat}`);
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

// --- Format search_context result (reader contract) ---

function detailLines(m: EpisodicMemory): string[] {
  const lines: string[] = [];
  for (const d of m.summary.decisions) {
    lines.push(`    - ${decisionLabel(d)}: ${d.text}`);
  }
  for (const pat of m.summary.patterns) lines.push(`    - Pattern: ${pat}`);
  for (const p of m.summary.problemsSolved) {
    lines.push(`    - Solved: ${p.problem} → ${p.resolution}`);
  }
  for (const t of m.summary.openThreads) lines.push(`    - Open: ${t}`);
  return lines;
}

/**
 * Format an escalating-recall result for the search_context tool. The output
 * is self-instructing: on a miss it tells the model to be honest and not
 * fabricate (mirroring the LongMemEval reader prompt); on a hit it tells the
 * model to answer only from the excerpts. `topK` caps how many hits are shown.
 */
export function formatSearchResult(
  query: string,
  result: RecallResult,
  topK: number,
): string {
  if (result.hits.length === 0) {
    const searched =
      result.scope === "all"
        ? "this project AND all other projects"
        : "this project";
    // Cross-project was asked for but is disabled by config — don't offer a
    // scope="all" retry the config would also refuse; say so plainly instead.
    const offer = result.crossProjectBlocked
      ? ` Cross-project search is disabled by configuration (BETTERDB_ALLOW_CROSS_PROJECT=false), so widening is not available.`
      : result.scope === "project"
        ? ` You may offer to search across ALL projects — call search_context again with scope="all".`
        : "";
    return [
      `# Memory search: "${query}"`,
      `Searched: ${searched}.`,
      `NO memories cleared the relevance threshold.`,
      `Tell the user you found nothing in memory about this. Do NOT fabricate an ` +
        `answer, and do NOT substitute a codebase search as if it were recall.${offer}`,
    ].join("\n");
  }

  const shown = result.hits.slice(0, topK);
  const lines: string[] = [
    `# Memory search: "${query}"`,
    `Scope: ${result.scope} · confidence: ${result.confidence} · ${shown.length} match(es)`,
    ``,
  ];
  shown.forEach((h, i) => {
    const date = h.memory.timestamp.split("T")[0];
    lines.push(
      `[${i + 1}] (rel ${h.relevance.toFixed(2)}, ${date}) ${h.memory.summary.oneLineSummary}`,
    );
    lines.push(...detailLines(h.memory));
  });
  lines.push(``);
  lines.push(
    `Answer the user ONLY from these excerpts. If they do not contain the answer, ` +
      `say so plainly — do not invent.`,
  );
  return lines.join("\n");
}
