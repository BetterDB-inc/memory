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
