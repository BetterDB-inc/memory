import { readRawPayload, runHook } from "./_utils.js";
import { getValkeyClient } from "../client/valkey.js";
import { createModelClient } from "../client/model.js";
import {
  SessionCapture,
  computeInitialImportance,
  getGitBranch,
  getCwdProject,
} from "../memory/capture.js";
import { SessionEventSchema, type EpisodicMemory } from "../memory/schema.js";
import { config, isConfigured } from "../config.js";
import { unlink } from "node:fs/promises";

/**
 * Stop hook (session-end): Captures the session transcript and stores a memory.
 *
 * Claude Code hooks contract:
 * - Fires when Claude finishes responding (Stop event)
 * - Receives JSON on stdin with session_id, transcript_path, cwd
 * - Exit 0 for success
 *
 * Capture strategy:
 * 1. Prefer transcript_path (complete conversation with user messages)
 * 2. Fall back to JSONL event file (tool calls only)
 * 3. If model client is unavailable, queue for later processing
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
  let transcript = "";

  // Prefer transcript_path — contains the full conversation including user messages
  if (transcriptPath) {
    transcript = await parseTranscriptPath(transcriptPath);
  }

  // Fall back to JSONL event file (tool calls captured by PostToolUse hook)
  if (!transcript) {
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
      transcript = capture.buildTranscript();
    }
  }

  // Nothing to store
  if (!transcript || transcript.length < 20) {
    await cleanup(eventFilePath);
    return;
  }

  // Cap transcript to ~8K chars to avoid overwhelming the summarizer
  // Keep first 4K (session start) + last 4K (session end) for long sessions
  const MAX_TRANSCRIPT = 8000;
  if (transcript.length > MAX_TRANSCRIPT) {
    const half = MAX_TRANSCRIPT / 2;
    transcript =
      transcript.slice(0, half) +
      "\n\n[... middle of session truncated ...]\n\n" +
      transcript.slice(-half);
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

  // Try to summarize; queue on failure
  let modelClient;
  try {
    modelClient = await createModelClient();
  } catch {
    console.error(
      "[betterdb] Ollama unavailable — transcript queued for later processing",
    );
    await valkeyClient.pushIngestQueue(transcript, {
      project,
      branch,
      timestamp: new Date().toISOString(),
      sessionId,
    });
    await valkeyClient.quit();
    await cleanup(eventFilePath);
    return;
  }

  const summary = await modelClient.summarize(transcript);
  const importance = computeInitialImportance(summary);
  const embedding = await modelClient.embed(summary.oneLineSummary);

  const memory: EpisodicMemory = {
    memoryId: crypto.randomUUID(),
    project,
    branch,
    timestamp: new Date().toISOString(),
    summary,
    importanceScore: importance,
    accessCount: 0,
    lastAccessed: new Date().toISOString(),
  };

  await valkeyClient.storeMemory(memory, embedding);
  await valkeyClient.quit();
  await cleanup(eventFilePath);
});

/**
 * Parse Claude Code's transcript JSONL into a clean text transcript.
 * The JSONL contains objects with type: "user" | "assistant" and message content.
 * We extract user/assistant turns to build a readable conversation.
 */
async function parseTranscriptPath(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";

  const raw = await file.text();
  const lines: string[] = [];

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
        if (content && !content.includes("<local-command") && !content.includes("<command-name>")) {
          lines.push(`User: ${content}`);
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
          lines.push(`Assistant: ${content.slice(0, 2000)}`);
        }
      } else if (entry.type === "tool_use" || entry.type === "tool_result") {
        // Include tool names for context but keep it brief
        const toolName = entry.tool_name ?? entry.name ?? "";
        if (toolName) {
          lines.push(`Tool: ${toolName}`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lines.join("\n");
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
