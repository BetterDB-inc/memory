import { rename, unlink } from "node:fs/promises";
import { parseTranscriptLine, selectTranscript } from "./transcript.js";

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

/**
 * Split a session-end tail into the segments to queue, in order.
 *
 * The Stop hook is an optimization, not a correctness requirement: when it
 * never ran (fresh install before a restart, Valkey unreachable) the whole
 * transcript arrives here. Capping that with a single `maxChars` selection
 * would silently discard everything past the cap — the truncation checkpoint
 * capture exists to remove. So chunk the tail exactly as Stop would, and let
 * only the final sub-threshold remainder go through `selectTranscript`.
 */
export function planTailSegments(
  turns: OffsetTurn[],
  threshold: number,
  maxChars: number,
): string[] {
  const segments: string[] = [];
  let remaining = turns;

  for (;;) {
    const result = nextChunk(remaining, threshold);
    if (result === null) {
      break;
    }
    segments.push(result.chunk);
    remaining = remaining.slice(result.consumedTurns);
  }

  const tail = selectTranscript(remaining, maxChars);
  if (tail.length > 0) {
    segments.push(tail);
  }

  return segments;
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

export async function parseTurnsFrom(
  path: string,
  fromByte: number,
): Promise<OffsetTurn[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }

  const bytes = new Uint8Array(await file.slice(fromByte).arrayBuffer());
  const decoder = new TextDecoder();
  const turns: OffsetTurn[] = [];
  let lineStart = 0;

  for (let i = 0; i <= bytes.length; i++) {
    const atEnd = i === bytes.length;
    if (!atEnd && bytes[i] !== 0x0a) {
      continue;
    }
    const lineBytes = bytes.subarray(lineStart, i);
    const endByte = fromByte + (atEnd ? i : i + 1);
    lineStart = i + 1;
    if (lineBytes.length === 0) {
      continue;
    }
    const line = decoder.decode(lineBytes).trim();
    if (!line) {
      continue;
    }
    for (const turn of parseTranscriptLine(line)) {
      turns.push({ ...turn, endByte });
    }
  }

  return turns;
}
