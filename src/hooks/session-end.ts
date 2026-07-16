import { readRawPayload, runHook } from "./_utils.js";
import { getValkeyClient } from "../client/valkey.js";
import {
  SessionCapture,
  getGitBranch,
  getCwdProject,
} from "../memory/capture.js";
import { SessionEventSchema } from "../memory/schema.js";
import { selectTranscript, type TranscriptTurn } from "../memory/transcript.js";
import { config, isConfigured } from "../config.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * SessionEnd hook: captures the session transcript and queues it.
 *
 * Claude Code hooks contract:
 * - Fires once when the session terminates
 * - Receives JSON on stdin with session_id, transcript_path, cwd, reason
 * - Exit 0 for success
 *
 * This hook performs NO model work. It queues the transcript and spawns a
 * detached drainer; AgingPipeline.processIngestQueue does the summarization.
 * Summarizing here would block the session on an LLM call.
 *
 * Capture strategy:
 * 1. Prefer transcript_path (complete conversation with user messages)
 * 2. Fall back to JSONL event file (tool calls only)
 */
runHook(async () => {
  if (!isConfigured()) return;
  const payload = await readRawPayload();
  const sessionId = payload["session_id"] as string;
  const cwd = (payload["cwd"] as string) ?? process.cwd();
  const transcriptPath = payload["transcript_path"] as string | undefined;

  if (cwd) {
    process.chdir(cwd);
  }

  const eventFilePath = `/tmp/betterdb-${sessionId}.jsonl`;
  let turns: TranscriptTurn[] = [];

  // Prefer transcript_path — contains the full conversation including user messages
  if (transcriptPath) {
    turns = await parseTranscriptTurns(transcriptPath);
  }

  // Fall back to JSONL event file (tool calls captured by PostToolUse hook).
  // Event lines rank as tool turns; with no user turns present the selector
  // keeps them, so a tool-only fallback transcript is never emptied.
  if (turns.length === 0) {
    const eventFile = Bun.file(eventFilePath);
    if (await eventFile.exists()) {
      const raw = await eventFile.text();
      const capture = new SessionCapture();
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const event = SessionEventSchema.parse(JSON.parse(line));
          capture.addEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
      turns = capture
        .buildTranscript()
        .split("\n")
        .filter(Boolean)
        .map((text) => ({ role: "tool" as const, text }));
    }
  }

  // Cap to ~8K chars for the summarizer via priority-based selection (user
  // turns > assistant turns near user turns > tool lines) instead of the old
  // head+tail slice, which dropped the middle of long sessions wholesale.
  const MAX_TRANSCRIPT = 8000;
  const transcript = selectTranscript(turns, MAX_TRANSCRIPT);

  // Nothing to store
  if (!transcript || transcript.length < 20) {
    await cleanup(eventFilePath);
    return;
  }

  let valkeyClient;
  try {
    valkeyClient = await getValkeyClient();
  } catch {
    await cleanup(eventFilePath);
    return; // Valkey unreachable — skip silently
  }

  const project = getCwdProject();
  const branch = getGitBranch();

  await valkeyClient.pushIngestQueue(transcript, {
    project,
    branch,
    timestamp: new Date().toISOString(),
    sessionId,
  });

  // Detached: unref() releases it from this process's event loop so the hook
  // exits immediately while summarization continues in the background.
  const drainBin = join(process.env["HOME"] ?? "", ".betterdb", "bin", "drain");
  if (await Bun.file(drainBin).exists()) {
    Bun.spawn([drainBin], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  }

  await valkeyClient.quit();
  await cleanup(eventFilePath);
});

/**
 * Parse Claude Code's transcript JSONL into role-tagged turns.
 * The JSONL contains objects with type: "user" | "assistant" and message content.
 * We extract user/assistant/tool turns so selectTranscript can rank them.
 */
async function parseTranscriptTurns(path: string): Promise<TranscriptTurn[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const raw = await file.text();
  const turns: TranscriptTurn[] = [];

  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text)
                  .join("\n")
              : "";
        // Skip system-generated messages (commands, caveats)
        if (
          content &&
          !content.includes("<local-command") &&
          !content.includes("<command-name>")
        ) {
          turns.push({ role: "user", text: `User: ${content}` });
        }
      } else if (entry.type === "assistant" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text)
                  .join("\n")
              : "";
        if (content) {
          turns.push({
            role: "assistant",
            text: `Assistant: ${content.slice(0, 2000)}`,
          });
        }
      } else if (entry.type === "tool_use" || entry.type === "tool_result") {
        // Include tool names for context but keep it brief
        const toolName = entry.tool_name ?? entry.name ?? "";
        if (toolName) {
          turns.push({ role: "tool", text: `Tool: ${toolName}` });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns;
}

async function cleanup(eventFilePath: string): Promise<void> {
  try {
    await unlink(eventFilePath);
  } catch {
    // File may not exist
  }
  try {
    const contextFile = Bun.file(config.memory.contextFile);
    if (await contextFile.exists()) {
      await unlink(config.memory.contextFile);
    }
  } catch {
    // Ignore cleanup errors
  }
}
