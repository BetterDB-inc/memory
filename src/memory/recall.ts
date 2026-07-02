import { config } from "../config.js";
import type { PluginMemoryStore, ScoredMemory } from "../client/memory-store.js";

// Over-fetch → gate → narrow, mirroring the LongMemEval harness (runner.ts:
// fetchK candidates, then slice to k). Dense recall is already ~95%; the gain
// is a bigger candidate set plus an honest relevance gate, so "found nothing"
// means "nothing cleared the threshold" rather than an empty KNN result (which
// almost never happens).

export interface RecallResult {
  hits: ScoredMemory[];
  scope: "project" | "all";
  /** 1: project/high · 2: project/low · 3: cross-project · 0: nothing. */
  rung: 0 | 1 | 2 | 3;
  confidence: "high" | "low" | "none";
}

/**
 * Escalating recall:
 *   rung 1 — project scope, wide pool, high relevance bar.
 *   rung 2 — project scope, wider pool, low bar.
 *   rung 3 — cross-project probe (no reinforcement), low bar. Only when
 *            `allowCrossProject` — the caller gates this on user consent / an
 *            explicit `scope=all`, since another project's memory is often
 *            noise or privacy-sensitive.
 * Stops at the first rung that yields hits.
 */
export async function escalatingRecall(
  store: PluginMemoryStore,
  query: string,
  project: string,
  allowCrossProject: boolean,
): Promise<RecallResult> {
  const { tauHigh, tauLow, poolK, poolKWide } = config.recall;

  // rung 1 — project, high bar
  let pool = await store.recall(query, { project, k: poolK });
  let hits = pool.filter((h) => h.relevance >= tauHigh);
  if (hits.length > 0) {
    return { hits, scope: "project", rung: 1, confidence: "high" };
  }

  // rung 2 — project, wider pool, low bar
  pool = await store.recall(query, { project, k: poolKWide });
  hits = pool.filter((h) => h.relevance >= tauLow);
  if (hits.length > 0) {
    return { hits, scope: "project", rung: 2, confidence: "low" };
  }

  // rung 3 — cross-project probe. reinforce:false so a speculative wide search
  // doesn't bump access counts on unrelated projects' memories.
  if (allowCrossProject) {
    pool = await store.recall(query, { k: poolKWide, reinforce: false });
    hits = pool.filter((h) => h.relevance >= tauLow);
    if (hits.length > 0) {
      return { hits, scope: "all", rung: 3, confidence: "low" };
    }
  }

  return {
    hits: [],
    scope: allowCrossProject ? "all" : "project",
    rung: 0,
    confidence: "none",
  };
}
