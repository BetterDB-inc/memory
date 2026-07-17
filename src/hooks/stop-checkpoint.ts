import { readRawPayload, runHook } from "./_utils.js";
import { getValkeyClient } from "../client/valkey.js";
import { getCwdProject, getGitBranch } from "../memory/capture.js";
import { isConfigured } from "../config.js";
import {
  CHECKPOINT_THRESHOLD,
  nextChunk,
  parseTurnsFrom,
  readCheckpoint,
  writeCheckpoint,
} from "../memory/checkpoint.js";

runHook(async () => {
  if (!isConfigured()) {
    return;
  }

  const payload = await readRawPayload();
  const sessionId = payload["session_id"] as string;
  const cwd = payload["cwd"] as string | undefined;
  const transcriptPath = payload["transcript_path"] as string | undefined;

  if (!sessionId || !transcriptPath) {
    return;
  }
  if (cwd) {
    process.chdir(cwd);
  }

  const transcript = Bun.file(transcriptPath);
  if (!(await transcript.exists())) {
    return;
  }

  const checkpoint = await readCheckpoint(sessionId);

  if (transcript.size <= checkpoint.byteOffset) {
    return;
  }

  const turns = await parseTurnsFrom(transcriptPath, checkpoint.byteOffset);
  const result = nextChunk(turns, CHECKPOINT_THRESHOLD);
  if (result === null) {
    return;
  }

  let valkeyClient;
  try {
    valkeyClient = await getValkeyClient();
  } catch {
    return;
  }

  await valkeyClient.pushIngestQueue(result.chunk, {
    project: getCwdProject(),
    branch: getGitBranch(),
    timestamp: new Date().toISOString(),
    sessionId,
    segment: checkpoint.segment,
  });

  await writeCheckpoint(sessionId, {
    byteOffset: result.endByte,
    segment: checkpoint.segment + 1,
  });

  await valkeyClient.quit();
});
