import { describe, expect, test, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  checkpointPath,
  readCheckpoint,
  writeCheckpoint,
  removeCheckpoint,
} from "../../src/memory/checkpoint.js";

const SID = "checkpoint-file-test";

afterEach(async () => {
  await unlink(checkpointPath(SID)).catch(() => {});
});

describe("checkpoint file", () => {
  test("missing file reads as the zero checkpoint", async () => {
    expect(await readCheckpoint(SID)).toEqual({ byteOffset: 0, segment: 0 });
  });

  test("round-trips a written checkpoint", async () => {
    await writeCheckpoint(SID, { byteOffset: 8002, segment: 1 });
    expect(await readCheckpoint(SID)).toEqual({ byteOffset: 8002, segment: 1 });
  });

  test("overwrites an existing checkpoint", async () => {
    await writeCheckpoint(SID, { byteOffset: 100, segment: 1 });
    await writeCheckpoint(SID, { byteOffset: 200, segment: 2 });
    expect(await readCheckpoint(SID)).toEqual({ byteOffset: 200, segment: 2 });
  });

  test("a corrupt file reads as the zero checkpoint", async () => {
    await Bun.write(checkpointPath(SID), "{not json");
    expect(await readCheckpoint(SID)).toEqual({ byteOffset: 0, segment: 0 });
  });

  test("removeCheckpoint deletes the file", async () => {
    await writeCheckpoint(SID, { byteOffset: 5, segment: 1 });
    await removeCheckpoint(SID);
    expect(await readCheckpoint(SID)).toEqual({ byteOffset: 0, segment: 0 });
  });
});
