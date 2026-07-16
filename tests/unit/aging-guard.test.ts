import { describe, expect, test } from "bun:test";
import { AgingPipeline } from "../../src/memory/aging.js";
import {
  SessionSummarySchema,
  type SessionSummary,
} from "../../src/memory/schema.js";

function fakeValkey(items: Array<{ transcript: string; meta: object }>) {
  const requeued: string[] = [];
  return {
    client: {
      popIngestQueue: async () => {
        return items.splice(0, items.length);
      },
      pushIngestQueue: async (t: string) => {
        requeued.push(t);
      },
    },
    requeued,
  };
}

function fakeStore(stored: SessionSummary[]) {
  return {
    storeMemory: async (m: { summary: SessionSummary }) => {
      stored.push(m.summary);
      return "id";
    },
  };
}

function fakeModel(summary: SessionSummary) {
  return {
    summarize: async () => {
      return summary;
    },
  };
}

describe("processIngestQueue empty-summary guard", () => {
  test("does not store a husk", async () => {
    const husk = SessionSummarySchema.parse({});
    const stored: SessionSummary[] = [];
    const vk = fakeValkey([{ transcript: "some transcript", meta: {} }]);

    const pipeline = new AgingPipeline(
      vk.client as never,
      fakeStore(stored) as never,
      fakeModel(husk) as never,
    );

    const result = await pipeline.processIngestQueue();

    expect(stored.length).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("does not re-queue a husk (no infinite loop)", async () => {
    const husk = SessionSummarySchema.parse({});
    const vk = fakeValkey([{ transcript: "some transcript", meta: {} }]);

    const pipeline = new AgingPipeline(
      vk.client as never,
      fakeStore([]) as never,
      fakeModel(husk) as never,
    );
    await pipeline.processIngestQueue();

    expect(vk.requeued.length).toBe(0);
  });

  test("stores a real summary", async () => {
    const real = SessionSummarySchema.parse({ oneLineSummary: "Did a thing" });
    const stored: SessionSummary[] = [];
    const vk = fakeValkey([{ transcript: "some transcript", meta: {} }]);

    const pipeline = new AgingPipeline(
      vk.client as never,
      fakeStore(stored) as never,
      fakeModel(real) as never,
    );
    const result = await pipeline.processIngestQueue();

    expect(stored.length).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
