import { describe, expect, test, afterAll } from "bun:test";
import { unlink } from "node:fs/promises";
import { getValkeyClient, resetValkeyClient } from "../../src/client/valkey.js";
import {
  CHECKPOINT_THRESHOLD,
  nextChunk,
  parseTurnsFrom,
  readCheckpoint,
  writeCheckpoint,
  removeCheckpoint,
  checkpointPath,
} from "../../src/memory/checkpoint.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";
const SID = "checkpoint-capture-it";
const FIXTURE = `/tmp/betterdb-${SID}.transcript.jsonl`;

const META = {
  project: "it",
  branch: "it",
  timestamp: "2026-07-17T00:00:00.000Z",
  sessionId: SID,
};

async function seedTranscript(): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < 14; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { content: `turn ${i} ` + "x".repeat(2500) },
      }),
    );
  }
  await Bun.write(FIXTURE, lines.join("\n") + "\n");
}

describe.skipIf(SKIP)("checkpoint capture integration", () => {
  afterAll(async () => {
    await unlink(FIXTURE).catch(() => {});
    await unlink(checkpointPath(SID)).catch(() => {});
    await resetValkeyClient();
  });

  test("produces sequential segments plus a tail", async () => {
    await seedTranscript();
    await removeCheckpoint(SID);

    const vk = await getValkeyClient();
    // Start from a clean queue without assuming a raw() accessor.
    await vk.popIngestQueue(10000);

    let loopSegments = 0;
    let exitedViaNull = false;
    for (let guard = 0; guard < 20; guard++) {
      const cp = await readCheckpoint(SID);
      const turns = await parseTurnsFrom(FIXTURE, cp.byteOffset);
      const result = nextChunk(turns, CHECKPOINT_THRESHOLD);
      if (result === null) {
        exitedViaNull = true;
        break;
      }
      await vk.pushIngestQueue(result.chunk, { ...META, segment: cp.segment });
      await writeCheckpoint(SID, {
        byteOffset: result.endByte,
        segment: cp.segment + 1,
      });
      loopSegments++;
    }

    const cp = await readCheckpoint(SID);
    const tail = await parseTurnsFrom(FIXTURE, cp.byteOffset);
    const tailText = tail.map((t) => t.text).join("\n");
    let tailPushed = false;
    if (tailText.length >= 20) {
      await vk.pushIngestQueue(tailText, { ...META, segment: cp.segment });
      tailPushed = true;
    }

    const items = await vk.popIngestQueue(50);
    await vk.quit();

    expect(exitedViaNull).toBe(true);
    expect(loopSegments).toBeGreaterThanOrEqual(2);
    expect(tailPushed).toBe(true);
    expect(items.length).toBe(loopSegments + 1);
    const segments = items.map((i) => (i.meta as { segment: number }).segment);
    expect(segments).toEqual([...Array(items.length).keys()]);
    for (const item of items) {
      expect(item.transcript.length).toBeGreaterThan(0);
    }
  });
});
