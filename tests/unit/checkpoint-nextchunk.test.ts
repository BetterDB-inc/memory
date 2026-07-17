import { describe, expect, test } from "bun:test";
import { nextChunk, type OffsetTurn } from "../../src/memory/checkpoint.js";

function turn(text: string, endByte: number): OffsetTurn {
  return { role: "user", text, endByte };
}

describe("nextChunk", () => {
  test("returns null when accumulated turns are below threshold", () => {
    const turns = [turn("a".repeat(10), 11), turn("b".repeat(10), 22)];
    expect(nextChunk(turns, 8000)).toBeNull();
  });

  test("emits the turn that crosses the threshold, whole", () => {
    const turns = [
      turn("a".repeat(5000), 5001),
      turn("b".repeat(4000), 9002),
      turn("c".repeat(10), 9013),
    ];
    const result = nextChunk(turns, 8000);
    expect(result).not.toBeNull();
    expect(result!.consumedTurns).toBe(2);
    expect(result!.endByte).toBe(9002);
    expect(result!.chunk).toBe("a".repeat(5000) + "\n" + "b".repeat(4000));
  });

  test("emits at exactly the threshold", () => {
    const turns = [turn("a".repeat(8000), 8001)];
    const result = nextChunk(turns, 8000);
    expect(result).not.toBeNull();
    expect(result!.consumedTurns).toBe(1);
  });

  test("emits a single over-threshold turn alone, never split", () => {
    const turns = [turn("a".repeat(20000), 20001), turn("b", 20003)];
    const result = nextChunk(turns, 8000);
    expect(result!.consumedTurns).toBe(1);
    expect(result!.chunk).toBe("a".repeat(20000));
    expect(result!.endByte).toBe(20001);
  });

  test("charges one newline between consumed turns", () => {
    const turns = [turn("a".repeat(4000), 4001), turn("b".repeat(3999), 8001)];
    const result = nextChunk(turns, 8000);
    expect(result).not.toBeNull();
    expect(result!.consumedTurns).toBe(2);
  });
});
