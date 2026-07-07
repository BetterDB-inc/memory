import { describe, expect, test } from "bun:test";
import { escalatingRecall } from "../../src/memory/recall.js";
import { formatSearchResult } from "../../src/memory/retrieval.js";
import type { PluginMemoryStore, ScoredMemory } from "../../src/client/memory-store.js";
import type { EpisodicMemory } from "../../src/memory/schema.js";

// --- Fixtures ---

const makeMemory = (summary: string): EpisodicMemory => ({
  memoryId: crypto.randomUUID(),
  project: "memory",
  branch: "main",
  timestamp: "2026-07-02T00:00:00.000Z",
  summary: {
    decisions: [],
    patterns: [],
    problemsSolved: [],
    openThreads: [],
    filesChanged: [],
    oneLineSummary: summary,
  },
  importanceScore: 0.8,
  accessCount: 0,
  lastAccessed: "2026-07-02T00:00:00.000Z",
});

const scored = (summary: string, relevance: number): ScoredMemory => ({
  memory: makeMemory(summary),
  relevance,
  score: relevance,
});

type RecallOpts = {
  project?: string;
  branch?: string;
  tags?: string[];
  k: number;
  threshold?: number;
  reinforce?: boolean;
};

/** Fake store: records every recall call and returns a scripted response. */
class FakeStore {
  readonly calls: RecallOpts[] = [];
  constructor(private readonly responder: (opts: RecallOpts) => ScoredMemory[]) {}
  async recall(_query: string, opts: RecallOpts): Promise<ScoredMemory[]> {
    this.calls.push(opts);
    return this.responder(opts);
  }
}

const asStore = (f: FakeStore): PluginMemoryStore =>
  f as unknown as PluginMemoryStore;

// --- Escalation ladder ---

describe("escalatingRecall", () => {
  test("rung 1: a confident project+branch hit stops immediately", async () => {
    const store = new FakeStore((opts) =>
      opts.branch === "main" ? [scored("confident", 0.7)] : [],
    );
    const result = await escalatingRecall(asStore(store), "q", {
      project: "memory",
      branch: "main",
      crossProjectRequested: true,
    });

    expect(result.rung).toBe(1);
    expect(result.scope).toBe("project");
    expect(result.confidence).toBe("high");
    expect(result.hits).toHaveLength(1);
    // Rung 1 = branch pool + manual-insight pool, then stop — no escalation.
    expect(store.calls).toHaveLength(2);
    // Rung 1 over-fetches the widened pool (k=10), not the old top-5.
    expect(store.calls[0]?.k).toBe(10);
    expect(store.calls[0]?.project).toBe("memory");
    // Rung 1 narrows to the current branch, plus the reserved manual thread.
    expect(store.calls[0]?.branch).toBe("main");
    expect(store.calls[1]?.project).toBe("memory");
    expect(store.calls[1]?.branch).toBe("manual");
    expect(store.calls[1]?.k).toBe(10);
    // Over-fetch is speculative and gated afterward, so it must not reinforce
    // the pre-gate pool.
    expect(store.calls[0]?.reinforce).toBe(false);
    expect(store.calls[1]?.reinforce).toBe(false);
  });

  test("no rung reinforces the pre-gate over-fetch pool", async () => {
    // Force all three rungs to run (project rungs miss, cross-project hits).
    const store = new FakeStore((opts) =>
      opts.project === undefined ? [scored("elsewhere", 0.6)] : [],
    );
    await escalatingRecall(asStore(store), "q", {
      project: "memory",
      branch: "main",
      crossProjectRequested: true,
    });

    expect(store.calls).toHaveLength(4);
    for (const call of store.calls) {
      expect(call.reinforce).toBe(false);
    }
  });

  test("rung 2: nothing on this branch; a project-wide hit is recovered", async () => {
    // Rung 1 scopes to the branch and finds nothing; rung 2 drops the branch
    // and widens the pool, recovering a memory from another branch.
    const store = new FakeStore((opts) =>
      opts.branch === undefined ? [scored("other-branch", 0.6)] : [],
    );
    const result = await escalatingRecall(asStore(store), "q", {
      project: "memory",
      branch: "feature",
      crossProjectRequested: true,
    });

    expect(result.rung).toBe(2);
    expect(result.scope).toBe("project");
    expect(result.hits).toHaveLength(1);
    expect(store.calls).toHaveLength(3);
    // Rung 2 keeps the project but drops the branch and widens the pool.
    expect(store.calls[2]?.project).toBe("memory");
    expect(store.calls[2]?.branch).toBeUndefined();
    expect(store.calls[2]?.k).toBe(20);
  });

  test("rung 3: cross-project probe when the project has nothing", async () => {
    const store = new FakeStore((opts) =>
      // In-project searches return nothing; the namespace-less probe hits.
      opts.project === undefined ? [scored("elsewhere", 0.5)] : [],
    );
    const result = await escalatingRecall(asStore(store), "q", {
      project: "memory",
      crossProjectRequested: true,
    });

    expect(result.rung).toBe(3);
    expect(result.scope).toBe("all");
    expect(store.calls).toHaveLength(3);
    // The cross-project probe drops the namespace and does not reinforce.
    expect(store.calls[2]?.project).toBeUndefined();
    expect(store.calls[2]?.reinforce).toBe(false);
  });

  test("tags filter is passed through at every rung", async () => {
    const store = new FakeStore(() => []);
    await escalatingRecall(asStore(store), "q", {
      project: "memory",
      branch: "main",
      tags: ["decision"],
      crossProjectRequested: true,
    });

    expect(store.calls).toHaveLength(4);
    for (const call of store.calls) {
      expect(call.tags).toEqual(["decision"]);
    }
  });

  test("cross-project disabled: never probes, reports a clean project miss", async () => {
    const store = new FakeStore(() => []);
    const result = await escalatingRecall(asStore(store), "q", {
      project: "memory",
      crossProjectRequested: false,
    });

    expect(result.rung).toBe(0);
    expect(result.scope).toBe("project");
    expect(result.confidence).toBe("none");
    expect(result.hits).toHaveLength(0);
    // Only the two project rungs ran — no cross-project call.
    expect(store.calls).toHaveLength(2);
  });

  test("canary regression: a relevant memory ranked below the old top-5 is recovered", async () => {
    // The pool has 5 irrelevant near-hits plus the canary at rank 6. The old
    // top-5 injection would have dropped it; the widened pool + relevance gate
    // surface it at rung 1.
    const store = new FakeStore((opts) =>
      opts.branch === "main"
        ? [
            scored("noise-1", 0.2),
            scored("noise-2", 0.2),
            scored("noise-3", 0.15),
            scored("noise-4", 0.15),
            scored("noise-5", 0.1),
            scored("CANARY-7Q4X9M-betterdb-valkey-proof", 0.72),
          ]
        : [],
    );
    const result = await escalatingRecall(asStore(store), "canary token", {
      project: "memory",
      branch: "main",
      crossProjectRequested: true,
    });

    expect(result.rung).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.memory.summary.oneLineSummary).toContain("CANARY-7Q4X9M");
  });

  test("dogfood regression: a manual insight is not masked by mediocre branch hits", async () => {
    // Manual insights are stored under the reserved "manual" branch. Before
    // the fix, rung 1 only queried the current branch: its mediocre hits
    // cleared the floor, stopped the ladder, and the far-more-relevant manual
    // insight (only visible branch-less at rung 2) was never seen.
    const store = new FakeStore((opts) => {
      if (opts.branch === "master") return [scored("old telemetry session", 0.75)];
      if (opts.branch === "manual") return [scored("valkey page-3 issue review", 0.95)];
      return [];
    });
    const result = await escalatingRecall(asStore(store), "valkey issue review", {
      project: "monitor-master",
      branch: "master",
      crossProjectRequested: false,
    });

    expect(result.rung).toBe(1);
    // The manual insight wins; the mediocre branch hit falls outside `margin`.
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.memory.summary.oneLineSummary).toBe(
      "valkey page-3 issue review",
    );
    expect(result.confidence).toBe("high");
  });

  test("rung 1 does not double-query when the branch IS the manual thread", async () => {
    const store = new FakeStore(() => []);
    await escalatingRecall(asStore(store), "q", {
      project: "memory",
      branch: "manual",
      crossProjectRequested: false,
    });

    // rung 1 (single manual-branch query) + rung 2 — no duplicate manual pool.
    expect(store.calls).toHaveLength(2);
    expect(store.calls[0]?.branch).toBe("manual");
    expect(store.calls[1]?.branch).toBeUndefined();
  });
});

// --- Reader-contract formatting ---

describe("formatSearchResult", () => {
  test("a miss at project scope forbids fabrication and offers cross-project", () => {
    const text = formatSearchResult(
      "canary token",
      { hits: [], scope: "project", rung: 0, confidence: "none", crossProjectBlocked: false },
      5,
    );
    expect(text).toContain("NO memories cleared the relevance threshold");
    expect(text).toContain("Do NOT fabricate");
    expect(text).toContain("do NOT substitute a codebase search");
    expect(text).toContain('scope="all"');
  });

  test("a miss at all scope does not offer to widen further", () => {
    const text = formatSearchResult(
      "canary token",
      { hits: [], scope: "all", rung: 0, confidence: "none", crossProjectBlocked: false },
      5,
    );
    expect(text).toContain("this project AND all other projects");
    expect(text).not.toContain('scope="all"');
  });

  test("a blocked cross-project miss says widening is disabled, not to retry", () => {
    // scope="all" was requested but BETTERDB_ALLOW_CROSS_PROJECT is off, so only
    // the project ran. Don't offer a scope="all" retry the config would refuse.
    const text = formatSearchResult(
      "canary token",
      { hits: [], scope: "project", rung: 0, confidence: "none", crossProjectBlocked: true },
      5,
    );
    expect(text).toContain("disabled by configuration");
    expect(text).not.toContain('search_context again with scope="all"');
  });

  test("a hit instructs answering only from the excerpts", () => {
    const text = formatSearchResult(
      "canary token",
      {
        hits: [scored("CANARY-7Q4X9M-betterdb-valkey-proof", 0.72)],
        scope: "project",
        rung: 1,
        confidence: "high",
        crossProjectBlocked: false,
      },
      5,
    );
    expect(text).toContain("CANARY-7Q4X9M");
    expect(text).toContain("confidence: high");
    expect(text).toContain("Answer the user ONLY from these excerpts");
  });

  test("a hit's excerpt includes every content type it was tagged with", () => {
    // A pattern-tagged memory must surface its pattern text, or a pattern-
    // filtered search returns a hit whose excerpt can't answer the query.
    const memory = makeMemory("mixed session");
    memory.summary.decisions = [{ text: "Adopt Bun", status: "done" }];
    memory.summary.patterns = ["Escalating recall ladder"];
    memory.summary.problemsSolved = [{ problem: "Slow KNN", resolution: "Over-fetch + gate" }];
    memory.summary.openThreads = ["Reconcile aging decay"];
    const text = formatSearchResult(
      "q",
      {
        hits: [{ memory, relevance: 0.7, score: 0.7 }],
        scope: "project",
        rung: 1,
        confidence: "high",
        crossProjectBlocked: false,
      },
      5,
    );
    expect(text).toContain("Decision: Adopt Bun");
    expect(text).toContain("Pattern: Escalating recall ladder");
    expect(text).toContain("Solved: Slow KNN → Over-fetch + gate");
    expect(text).toContain("Open: Reconcile aging decay");
  });

  test("top_k caps how many hits are shown", () => {
    const hits = Array.from({ length: 8 }, (_, i) => scored(`mem-${i}`, 0.6));
    const text = formatSearchResult(
      "q",
      { hits, scope: "project", rung: 1, confidence: "high", crossProjectBlocked: false },
      3,
    );
    expect(text).toContain("3 match(es)");
    expect(text).toContain("mem-2");
    expect(text).not.toContain("mem-3");
  });
});
