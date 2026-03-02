import { readRawPayload, runHook } from "./_utils.js";
import { appendFile } from "node:fs/promises";
import type { SessionEvent } from "../memory/schema.js";

/**
 * PostToolUse hook: Records tool call results to a temp JSONL file.
 *
 * Claude Code hooks contract:
 * - Fires after a tool call succeeds
 * - Receives JSON on stdin with tool_name, tool_input, tool_result
 * - Exit 0 for success
 *
 * The JSONL file is read by session-end.ts to build the session transcript.
 */
runHook(async () => {
  const payload = await readRawPayload();
  const sessionId = payload["session_id"] as string;
  const toolName = (payload["tool_name"] as string) ?? "unknown";
  const toolInput = payload["tool_input"] as Record<string, unknown> | undefined;
  const toolResult = payload["tool_result"];

  const filePath =
    (toolInput?.["file_path"] as string) ??
    (toolInput?.["path"] as string) ??
    undefined;

  // Build a concise content string
  const inputSummary = toolInput
    ? JSON.stringify(toolInput).slice(0, 500)
    : "";
  const resultSummary =
    typeof toolResult === "string"
      ? toolResult.slice(0, 500)
      : JSON.stringify(toolResult ?? "").slice(0, 500);

  const event: SessionEvent = {
    sessionId,
    timestamp: new Date().toISOString(),
    eventType: "tool_call",
    content: `${toolName}: ${inputSummary} → ${resultSummary}`,
    filePath,
  };

  const eventFilePath = `/tmp/betterdb-${sessionId}.jsonl`;
  await appendFile(eventFilePath, JSON.stringify(event) + "\n");
});
