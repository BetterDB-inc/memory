import { describe, expect, test } from "bun:test";
import { flushSegments } from "../../src/hooks/flush-segments.js";

const META = {
  project: "p",
  branch: "b",
  sessionId: "s",
  baseSegment: 3,
};

describe("flushSegments", () => {
  test("pushes every segment with sequential segment numbers", async () => {
    const pushed: Array<{ text: string; segment: number }> = [];
    const client = {
      pushIngestQueue: async (text: string, meta: { segment: number }) => {
        pushed.push({ text, segment: meta.segment });
      },
    };

    const result = await flushSegments(client, ["one", "two"], META);

    expect(result).toEqual({ pushed: 2, failed: false });
    expect(pushed.map((p) => p.segment)).toEqual([3, 4]);
  });

  test("a mid-loop failure reports partial progress instead of throwing", async () => {
    // SessionEnd runs once; an escaped exception here skipped both the drain
    // spawn and cleanup, stranding the already-queued segments unsummarized.
    let calls = 0;
    const client = {
      pushIngestQueue: async () => {
        calls++;
        if (calls > 1) throw new Error("connection dropped");
      },
    };

    const result = await flushSegments(client, ["one", "two", "three"], META);

    expect(result).toEqual({ pushed: 1, failed: true });
  });
});
