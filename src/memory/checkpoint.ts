import { rename, unlink } from "node:fs/promises";

export interface OffsetTurn {
  role: "user" | "assistant" | "tool";
  text: string;
  endByte: number;
}

export const CHECKPOINT_THRESHOLD = 8000;

export function nextChunk(
  turns: OffsetTurn[],
  threshold: number,
): { chunk: string; endByte: number; consumedTurns: number } | null {
  let length = 0;
  for (let i = 0; i < turns.length; i++) {
    length += (i > 0 ? 1 : 0) + turns[i]!.text.length;
    if (length >= threshold) {
      const consumed = turns.slice(0, i + 1);
      return {
        chunk: consumed.map((t) => t.text).join("\n"),
        endByte: turns[i]!.endByte,
        consumedTurns: i + 1,
      };
    }
  }
  return null;
}

export interface Checkpoint {
  byteOffset: number;
  segment: number;
}

const ZERO_CHECKPOINT: Checkpoint = { byteOffset: 0, segment: 0 };

export function checkpointPath(sessionId: string): string {
  return `/tmp/betterdb-${sessionId}.checkpoint.json`;
}

export async function readCheckpoint(sessionId: string): Promise<Checkpoint> {
  const file = Bun.file(checkpointPath(sessionId));
  if (!(await file.exists())) {
    return { ...ZERO_CHECKPOINT };
  }
  try {
    const parsed = (await file.json()) as Partial<Checkpoint>;
    if (
      typeof parsed.byteOffset !== "number" ||
      typeof parsed.segment !== "number"
    ) {
      return { ...ZERO_CHECKPOINT };
    }
    return { byteOffset: parsed.byteOffset, segment: parsed.segment };
  } catch {
    return { ...ZERO_CHECKPOINT };
  }
}

export async function writeCheckpoint(
  sessionId: string,
  cp: Checkpoint,
): Promise<void> {
  const target = checkpointPath(sessionId);
  const tmp = `${target}.tmp`;
  await Bun.write(tmp, JSON.stringify(cp));
  await rename(tmp, target);
}

export async function removeCheckpoint(sessionId: string): Promise<void> {
  await unlink(checkpointPath(sessionId)).catch(() => {});
}
