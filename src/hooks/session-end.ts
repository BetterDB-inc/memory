import { readRawPayload, runHook } from "./_utils.js";
import { getValkeyClient } from "../client/valkey.js";
import {
  SessionCapture,
  getGitBranch,
  getCwdProject,
} from "../memory/capture.js";
import { SessionEventSchema } from "../memory/schema.js";
import {
  CHECKPOINT_THRESHOLD,
  parseTurnsFrom,
  planTailSegments,
  readCheckpoint,
  removeCheckpoint,
  type OffsetTurn,
} from "../memory/checkpoint.js";
import { config, isConfigured } from "../config.js";
import { flushSegments } from "./flush-segments.js";
import { locateDrainCommand } from "./locate-drain.js";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  const checkpoint = await readCheckpoint(sessionId);
  let turns: OffsetTurn[] = [];

  if (transcriptPath) {
    turns = await parseTurnsFrom(transcriptPath, checkpoint.byteOffset);
  }

  // Fall back to JSONL event file (tool calls captured by PostToolUse hook)
  // only when no checkpoint ever ran. Event lines rank as tool turns; with no
  // user turns present the selector keeps them, so a tool-only fallback
  // transcript is never emptied. After a checkpoint an empty tail means the
  // transcript is already fully queued, and the event file covers the whole
  // session — re-queueing it would duplicate earlier segments.
  if (turns.length === 0 && checkpoint.segment === 0) {
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
        .map((text) => ({ role: "tool" as const, text, endByte: 0 }));
    }
  }

  // Chunk the tail the way Stop does rather than capping it once: a session
  // whose Stop hook never checkpointed arrives here whole, and a single cap
  // would discard everything past it. Only the sub-threshold remainder is
  // selected down.
  const MAX_TRANSCRIPT = 8000;
  const segments = planTailSegments(
    turns,
    CHECKPOINT_THRESHOLD,
    MAX_TRANSCRIPT,
  ).filter((text) => text.length >= 20);

  // Nothing new to store. The Stop hook may still have queued segments this
  // session, and it never spawns a drainer — so returning here without one
  // would leave them unsummarized until some later session happened to drain.
  if (segments.length === 0) {
    if (checkpoint.segment > 0) {
      await spawnDrain();
    }
    await cleanup(eventFilePath, sessionId);
    return;
  }

  let valkeyClient;
  try {
    valkeyClient = await getValkeyClient();
  } catch {
    await cleanup(eventFilePath, sessionId);
    return; // Valkey unreachable — skip silently
  }

  const { pushed } = await flushSegments(valkeyClient, segments, {
    project: getCwdProject(),
    branch: getGitBranch(),
    sessionId,
    baseSegment: checkpoint.segment,
  });

  // Drain even after a partial flush: the Stop hook's segments and whatever
  // was pushed before the failure are already queued and nothing else will
  // summarize them this session.
  if (pushed > 0 || checkpoint.segment > 0) {
    await spawnDrain();
  }

  await valkeyClient.quit().catch(() => {});
  await cleanup(eventFilePath, sessionId);
});

/**
 * Spawn the detached drainer. unref() releases it from this process's event
 * loop, so the hook exits immediately while summarization continues.
 */
async function spawnDrain(): Promise<void> {
  // HOME is unset on Windows, where install and config both fall back to
  // USERPROFILE.
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const cmd = await locateDrainCommand({
    execDir: dirname(process.execPath),
    installBinDir: join(home, ".betterdb", "bin"),
    sourceDir: import.meta.dir,
  });
  if (!cmd) {
    console.error(
      "[betterdb] no drain binary or source found — queued transcripts stay queued until `betterdb-memory drain` runs",
    );
    return;
  }
  Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}

async function cleanup(
  eventFilePath: string,
  sessionId: string,
): Promise<void> {
  await removeCheckpoint(sessionId);
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
