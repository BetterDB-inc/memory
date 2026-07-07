import { z } from "zod";

// --- Session Events ---

export const SessionEventSchema = z.object({
  sessionId: z.string(),
  timestamp: z.string().datetime(),
  eventType: z.enum(["tool_call", "tool_result", "error", "file_change"]),
  content: z.string(),
  filePath: z.string().optional(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

// --- Session Summary (output of summarizer) ---

/**
 * Provenance of a decision. "done" = actually made/implemented in the session;
 * "proposed" = an option that was suggested but not committed to; "rejected" =
 * an option that was turned down; "open" = still undecided. Keeps the
 * summarizer from flattening a discussion of options into a list of "made"
 * decisions.
 */
export const DecisionStatusSchema = z.enum([
  "done",
  "proposed",
  "rejected",
  "open",
]);

export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/**
 * A decision with status provenance and an optional verbatim `quote` from the
 * transcript that supports it (used by grounding, stripped before storage).
 * Legacy summaries stored plain strings — the preprocess coerces those to
 * `{ text, status: "done" }` so old memories keep parsing.
 */
export const DecisionSchema = z.preprocess(
  (v) => (typeof v === "string" ? { text: v, status: "done" } : v),
  z.object({
    text: z.string(),
    status: DecisionStatusSchema.default("done"),
    quote: z.string().optional(),
  }),
);

export type Decision = z.infer<typeof DecisionSchema>;

export const SessionSummarySchema = z.object({
  decisions: z.array(DecisionSchema).max(10).default([]),
  patterns: z.array(z.string()).max(5).default([]),
  problemsSolved: z
    .array(
      z.object({
        problem: z.string(),
        resolution: z.string(),
        /** Verbatim supporting quote (grounding input, stripped before storage). */
        quote: z.string().optional(),
      }),
    )
    .max(5)
    .default([]),
  openThreads: z.array(z.string()).max(5).default([]),
  filesChanged: z.array(z.string()).default([]),
  oneLineSummary: z
    .string()
    .default("Session recorded — summary unavailable"),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// --- Episodic Memory ---

export const EpisodicMemorySchema = z.object({
  memoryId: z.string().uuid(),
  project: z.string(),
  branch: z.string(),
  timestamp: z.string().datetime(),
  summary: SessionSummarySchema,
  importanceScore: z.number().min(0).max(1),
  accessCount: z.number().int().nonnegative(),
  lastAccessed: z.string().datetime(),
});

export type EpisodicMemory = z.infer<typeof EpisodicMemorySchema>;

// --- Knowledge Entry ---

export const KnowledgeEntrySchema = z.object({
  entryId: z.string().uuid(),
  project: z.string(),
  topic: z.string(),
  fact: z.string(),
  confidence: z.number().min(0).max(1),
  sourceMemoryIds: z.array(z.string().uuid()),
  lastUpdated: z.string().datetime(),
  accessCount: z.number().int().nonnegative(),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

// --- Hook Payloads (Claude Code Hooks API) ---
// See: https://docs.anthropic.com/en/docs/claude-code/hooks

const BaseHookPayload = z.object({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string(),
});

export const SessionStartPayload = BaseHookPayload.extend({
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
});

export const StopPayload = BaseHookPayload.extend({
  hook_event_name: z.literal("Stop"),
});

export const PreToolUsePayload = BaseHookPayload.extend({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).optional(),
});

export const PostToolUsePayload = BaseHookPayload.extend({
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).optional(),
  tool_result: z.unknown().optional(),
});

export const HookPayloadSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartPayload,
  StopPayload,
  PreToolUsePayload,
  PostToolUsePayload,
]);

export type HookPayload = z.infer<typeof HookPayloadSchema>;
export type SessionStartHookPayload = z.infer<typeof SessionStartPayload>;
export type StopHookPayload = z.infer<typeof StopPayload>;
export type PreToolUseHookPayload = z.infer<typeof PreToolUsePayload>;
export type PostToolUseHookPayload = z.infer<typeof PostToolUsePayload>;
