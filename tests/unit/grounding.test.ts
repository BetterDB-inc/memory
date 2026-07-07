import { describe, expect, test } from "bun:test";
import { groundSummary } from "../../src/memory/grounding.js";
import type { SessionSummary } from "../../src/memory/schema.js";

const TRANSCRIPT = [
  "User: let's use Valkey vector search for recall",
  "Assistant: Agreed — I'll wire recall through Valkey vector search.",
  "User: the slow KNN problem?",
  "Assistant: Fixed the slow KNN by over-fetching and gating afterwards.",
].join("\n");

const base = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  decisions: [],
  patterns: [],
  problemsSolved: [],
  openThreads: [],
  filesChanged: [],
  oneLineSummary: "session",
  ...over,
});

describe("groundSummary", () => {
  test("keeps a decision whose quote appears verbatim, stripping the quote", () => {
    const out = groundSummary(
      base({
        decisions: [
          {
            text: "Use Valkey vector search",
            status: "done",
            quote: "use Valkey vector search for recall",
          },
        ],
      }),
      TRANSCRIPT,
    );
    expect(out.decisions).toEqual([
      { text: "Use Valkey vector search", status: "done" },
    ]);
  });

  test("quote matching normalizes case and whitespace", () => {
    const out = groundSummary(
      base({
        decisions: [
          {
            text: "Wire recall through Valkey",
            status: "done",
            quote: "  WIRE recall\n  through   valkey Vector search",
          },
        ],
      }),
      TRANSCRIPT,
    );
    expect(out.decisions).toHaveLength(1);
  });

  test("drops a decision whose quote is not in the transcript", () => {
    const out = groundSummary(
      base({
        decisions: [
          {
            text: "Adopted Postgres",
            status: "done",
            quote: "we adopted Postgres for storage",
          },
        ],
      }),
      TRANSCRIPT,
    );
    expect(out.decisions).toEqual([]);
  });

  test("drops a decision with no quote at all", () => {
    const out = groundSummary(
      base({ decisions: [{ text: "Invented decision", status: "done" }] }),
      TRANSCRIPT,
    );
    expect(out.decisions).toEqual([]);
  });

  test("drops a decision whose quote is too short to be evidence", () => {
    // "recall" appears in the transcript but is trivially matchable.
    const out = groundSummary(
      base({ decisions: [{ text: "Something", status: "done", quote: "recall" }] }),
      TRANSCRIPT,
    );
    expect(out.decisions).toEqual([]);
  });

  test("applies the same gate to problemsSolved", () => {
    const out = groundSummary(
      base({
        problemsSolved: [
          {
            problem: "Slow KNN",
            resolution: "Over-fetch and gate",
            quote: "Fixed the slow KNN by over-fetching",
          },
          {
            problem: "Invented outage",
            resolution: "Invented fix",
            quote: "we fixed the production outage",
          },
        ],
      }),
      TRANSCRIPT,
    );
    expect(out.problemsSolved).toEqual([
      { problem: "Slow KNN", resolution: "Over-fetch and gate" },
    ]);
  });

  test("passes patterns, openThreads, files, and one-liner through untouched", () => {
    const summary = base({
      patterns: ["escalating recall"],
      openThreads: ["tune the gate"],
      filesChanged: ["/src/recall.ts"],
      oneLineSummary: "did things",
    });
    const out = groundSummary(summary, TRANSCRIPT);
    expect(out.patterns).toEqual(["escalating recall"]);
    expect(out.openThreads).toEqual(["tune the gate"]);
    expect(out.filesChanged).toEqual(["/src/recall.ts"]);
    expect(out.oneLineSummary).toBe("did things");
  });

  test("preserves non-done statuses on grounded decisions", () => {
    const out = groundSummary(
      base({
        decisions: [
          {
            text: "Use Postgres instead",
            status: "rejected",
            quote: "let's use Valkey vector search",
          },
        ],
      }),
      TRANSCRIPT,
    );
    expect(out.decisions[0]?.status).toBe("rejected");
  });
});
