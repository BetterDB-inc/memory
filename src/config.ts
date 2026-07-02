import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
  ".betterdb",
  "memory.json",
);

/**
 * Load saved config from ~/.betterdb/memory.json as fallback for env vars.
 * This allows compiled binaries (hooks, MCP server) to work without
 * requiring env vars to be set — config is saved during `install`.
 */
const _fileConfig: Record<string, string> = (() => {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof data !== "object" || data === null) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string") result[k] = v;
      else if (typeof v === "number") result[k] = String(v);
    }
    return result;
  } catch {
    return {};
  }
})();

/** Read a config value: env var takes priority, then ~/.betterdb/memory.json. */
function env(key: string): string | undefined {
  return Bun.env[key] ?? _fileConfig[key];
}

export const config = {
  valkey: {
    url: env("BETTERDB_VALKEY_URL") ?? "redis://localhost:6379",
    indexName: env("BETTERDB_VALKEY_INDEX_NAME") ?? "betterdb-memory-index",
  },
  ollama: {
    url: env("BETTERDB_OLLAMA_URL") ?? "http://localhost:11434",
    embedModel: env("BETTERDB_EMBED_MODEL") ?? "mxbai-embed-large",
    summarizeModel: env("BETTERDB_SUMMARIZE_MODEL") ?? "mistral:7b",
    embedDim: Number(env("BETTERDB_EMBED_DIM") ?? 1024),
  },
  memory: {
    maxContextMemories: Number(env("BETTERDB_MAX_CONTEXT_MEMORIES") ?? 5),
    compressThreshold: Number(env("BETTERDB_COMPRESS_THRESHOLD") ?? 0.3),
    distillMinSessions: Number(env("BETTERDB_DISTILL_MIN_SESSIONS") ?? 5),
    contextFile: env("BETTERDB_CONTEXT_FILE") ?? ".betterdb_context.md",
    agingIntervalHours: Number(env("BETTERDB_AGING_INTERVAL_HOURS") ?? 6),
  },
  recall: {
    // Relative gate — model-agnostic (embed models compress cosine similarity
    // into different bands, so absolute thresholds don't transfer). `floor`
    // drops genuine noise and loosens the store's own distance gate; `margin`
    // keeps hits within that similarity of the top match; `separation` is the
    // top-vs-next gap above which a result is "high" confidence.
    floor: Number(env("BETTERDB_RECALL_FLOOR") ?? 0.5),
    margin: Number(env("BETTERDB_RECALL_MARGIN") ?? 0.05),
    separation: Number(env("BETTERDB_RECALL_SEPARATION") ?? 0.04),
    // Over-fetch pool sizes: rung-1 (project) and rung-2/3 (wider / cross).
    poolK: Number(env("BETTERDB_RECALL_POOL_K") ?? 10),
    poolKWide: Number(env("BETTERDB_RECALL_POOL_K_WIDE") ?? 20),
    // Allow the ladder / search_context to fall back to cross-project scope.
    allowCrossProject: env("BETTERDB_ALLOW_CROSS_PROJECT") !== "false",
    // Composite recall scoring, owned by @betterdb/agent-memory: a weighted
    // blend of semantic similarity, recency (half-life decay), and importance.
    // Recency is the ONE time-decay in the system — it replaces the old, unused
    // per-day `decayRate`. `halfLifeDays` is the age at which a memory's recency
    // term halves; weights (defaults match the store's) blend the three terms.
    halfLifeDays: Number(env("BETTERDB_RECALL_HALF_LIFE_DAYS") ?? 7),
    weightSimilarity: Number(env("BETTERDB_RECALL_WEIGHT_SIMILARITY") ?? 0.6),
    weightRecency: Number(env("BETTERDB_RECALL_WEIGHT_RECENCY") ?? 0.25),
    weightImportance: Number(env("BETTERDB_RECALL_WEIGHT_IMPORTANCE") ?? 0.15),
  },
  allowRemoteFallback: env("BETTERDB_ALLOW_REMOTE_FALLBACK") !== "false",
  providers: {
    embedProvider: env("BETTERDB_EMBED_PROVIDER") as
      | "local" | "ollama" | "openai" | "voyage" | "groq" | "together"
      | undefined,
    summarizeProvider: env("BETTERDB_SUMMARIZE_PROVIDER") as
      | "ollama" | "openai" | "anthropic" | "groq" | "together"
      | undefined,
    openaiKey: env("OPENAI_API_KEY"),
    anthropicKey: env("ANTHROPIC_API_KEY"),
    voyageKey: env("VOYAGE_API_KEY"),
    groqKey: env("GROQ_API_KEY"),
    togetherKey: env("TOGETHER_API_KEY"),
  },
} as const;

export type Config = typeof config;

/** Returns true if ~/.betterdb/memory.json exists (i.e. setup has been run). */
export function isConfigured(): boolean {
  return existsSync(CONFIG_PATH);
}
