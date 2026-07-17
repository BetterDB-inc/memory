import { describe, expect, test } from "bun:test";
import { planTailSegments, type OffsetTurn } from "../../src/memory/checkpoint.js";

const THRESHOLD = 8000;
const MAX_CHARS = 8000;

function turn(text: string): OffsetTurn {
  return { role: "user", text, endByte: 0 };
}

describe("planTailSegments", () => {
  test("returns nothing for no turns", () => {
    expect(planTailSegments([], THRESHOLD, MAX_CHARS)).toEqual([]);
  });

  test("emits a sub-threshold tail as a single segment", () => {
    const segments = planTailSegments([turn("a".repeat(100))], THRESHOLD, MAX_CHARS);
    expect(segments).toEqual(["a".repeat(100)]);
  });

  test("chunks a large tail instead of truncating it", () => {
    // 10 turns x 2500 chars = ~25K: far past a single 8K cap. The old
    // single-selectTranscript path kept 8K and dropped the rest.
    const turns = Array.from({ length: 10 }, (_, i) => turn(`${i} ` + "x".repeat(2500)));
    const segments = planTailSegments(turns, THRESHOLD, MAX_CHARS);

    expect(segments.length).toBeGreaterThan(1);
    const totalKept = segments.reduce((n, s) => n + s.length, 0);
    const totalInput = turns.reduce((n, t) => n + t.text.length, 0);
    // Only newline joins separate them, so essentially nothing is discarded.
    expect(totalKept).toBeGreaterThanOrEqual(totalInput);
  });

  test("every full chunk except the last reaches the threshold", () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(`${i} ` + "x".repeat(2500)));
    const segments = planTailSegments(turns, THRESHOLD, MAX_CHARS);
    for (const segment of segments.slice(0, -1)) {
      expect(segment.length).toBeGreaterThanOrEqual(THRESHOLD);
    }
  });

  test("emits a single over-threshold turn as its own segment, never split", () => {
    const huge = "x".repeat(20000);
    const segments = planTailSegments([turn(huge)], THRESHOLD, MAX_CHARS);
    expect(segments).toEqual([huge]);
  });

  test("does not append an empty trailing segment when the tail divides evenly", () => {
    const turns = [turn("x".repeat(8000)), turn("y".repeat(8000))];
    const segments = planTailSegments(turns, THRESHOLD, MAX_CHARS);
    expect(segments).toEqual(["x".repeat(8000), "y".repeat(8000)]);
    expect(segments.every((s) => s.length > 0)).toBe(true);
  });
});
