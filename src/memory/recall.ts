import { config } from "../config.js";
import type { PluginMemoryStore, ScoredMemory } from "../client/memory-store.js";

// Over-fetch → gate → narrow, mirroring the LongMemEval harness. Dense recall
// is already ~95%; the gain is a real candidate set plus an honest gate, so
// "found nothing" means "nothing cleared the gate" rather than an empty KNN.
//
// The gate is RELATIVE, not an absolute similarity threshold. Embed models
// compress cosine similarity into different, narrow bands (mxbai-embed-large
// packs everything into ~0.7–0.88; all-MiniLM differs), so a fixed tau doesn't
// transfer across models. Instead: loosen the store's own distance gate to a
// generous floor, drop genuine noise below that floor, then keep only the hits
// within `margin` of the top match. Confidence comes from the top-vs-next gap,
// which is scale-independent.

export interface RecallResult {
  hits: ScoredMemory[];
  scope: "project" | "all";
  /** 1: project+branch (or project) · 2: project · 3: cross-project · 0: nothing. */
  rung: 0 | 1 | 2 | 3;
  confidence: "high" | "low" | "none";
}

/** Scoping for {@link escalatingRecall}. */
export interface RecallQuery {
  project: string;
  /** Git branch (native thread scope). Rung 1 narrows to it when present. */
  branch?: string;
  /** Content-type filter (e.g. `["decision"]`) applied at every rung. */
  tags?: string[];
  allowCrossProject: boolean;
}

interface Gated {
  hits: ScoredMemory[];
  confidence: "high" | "low" | "none";
}

/** Keep hits within `margin` of the top match above `floor`; grade by gap. */
function gate(pool: ScoredMemory[]): Gated {
  const { floor, margin, separation } = config.recall;
  const eligible = pool
    .filter((h) => h.relevance >= floor)
    .sort((a, b) => b.relevance - a.relevance);
  if (eligible.length === 0) return { hits: [], confidence: "none" };

  const top = eligible[0]!.relevance;
  const hits = eligible.filter((h) => h.relevance >= top - margin);
  const second = eligible[1]?.relevance ?? -Infinity;
  // A clear peak above the rest → confident; a bunched cluster (e.g. many
  // near-duplicate file-history entries) → low, honestly.
  const confidence =
    eligible.length === 1 || top - second >= separation ? "high" : "low";
  return { hits, confidence };
}

/** Distance gate to hand the store so its strict default (0.25) doesn't
 * pre-filter everything: similarity `floor` ↔ distance `2·(1 − floor)`. */
function storeThreshold(): number {
  return 2 * (1 - config.recall.floor);
}

/**
 * Escalating recall, narrow → wide:
 *   rung 1 — project + `branch` (when given), pool `poolK`. Same project and
 *            branch is the most relevant scope; without a branch this is just
 *            project scope.
 *   rung 2 — project, any branch, wider pool `poolKWide`.
 *   rung 3 — cross-project probe (no reinforcement). Only when
 *            `allowCrossProject` — the caller gates this on user consent / an
 *            explicit `scope=all`, since another project's memory is often
 *            noise or privacy-sensitive.
 * A `tags` filter, when present, applies at every rung. Stops at the first rung
 * that yields gated hits.
 */
export async function escalatingRecall(
  store: PluginMemoryStore,
  query: string,
  q: RecallQuery,
): Promise<RecallResult> {
  const { poolK, poolKWide } = config.recall;
  const threshold = storeThreshold();
  const { project, branch, tags, allowCrossProject } = q;

  // rung 1 — project + branch (most specific).
  let pool = await store.recall(query, {
    project,
    ...(branch !== undefined ? { branch } : {}),
    tags,
    k: poolK,
    threshold,
  });
  let g = gate(pool);
  if (g.hits.length > 0) {
    return { hits: g.hits, scope: "project", rung: 1, confidence: g.confidence };
  }

  // rung 2 — project, any branch, wider pool.
  pool = await store.recall(query, { project, tags, k: poolKWide, threshold });
  g = gate(pool);
  if (g.hits.length > 0) {
    return { hits: g.hits, scope: "project", rung: 2, confidence: g.confidence };
  }

  // rung 3 — cross-project probe. reinforce:false so a speculative wide search
  // doesn't bump access counts on unrelated projects' memories.
  if (allowCrossProject) {
    pool = await store.recall(query, {
      tags,
      k: poolKWide,
      threshold,
      reinforce: false,
    });
    g = gate(pool);
    if (g.hits.length > 0) {
      return { hits: g.hits, scope: "all", rung: 3, confidence: g.confidence };
    }
  }

  return {
    hits: [],
    scope: allowCrossProject ? "all" : "project",
    rung: 0,
    confidence: "none",
  };
}
