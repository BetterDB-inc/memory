import type { HookPayload } from "../memory/schema.js";
import { HookPayloadSchema } from "../memory/schema.js";

/**
 * Read and parse hook payload from stdin.
 * Claude Code sends JSON on stdin for command hooks.
 */
export async function readPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("No payload received on stdin");
  }
  const json = JSON.parse(raw);
  return HookPayloadSchema.parse(json);
}

/**
 * Read raw JSON from stdin without schema validation.
 * Used when the hook needs partial fields from a payload
 * that may not match the discriminated union.
 */
export async function readRawPayload(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("No payload received on stdin");
  }
  return JSON.parse(raw);
}

/**
 * Safe wrapper for hook execution.
 * Catches all errors → stderr. Always exits 0 to never crash Claude Code.
 */
export async function runHook(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.exit(0);
  } catch (err) {
    console.error(
      "[betterdb]",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(0); // Always exit 0 — never block Claude Code
  }
}
