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

function failingModel() {
  return {
    summarize: async () => {
      throw new Error("summarizer unavailable");
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

describe("processIngestQueue failure handling", () => {
  test("re-queues the failed item and every remaining popped item", async () => {
    // The pop is destructive: anything popped but neither stored nor
    // re-queued is lost forever when the drain process exits.
    const vk = fakeValkey([
      { transcript: "first", meta: {} },
      { transcript: "second", meta: {} },
      { transcript: "third", meta: {} },
    ]);

    const pipeline = new AgingPipeline(
      vk.client as never,
      fakeStore([]) as never,
      failingModel() as never,
    );
    const result = await pipeline.processIngestQueue();

    expect(result.processed).toBe(0);
    expect(vk.requeued.sort()).toEqual(["first", "second", "third"]);
  });

  test("re-queues only the unprocessed tail when a later item fails", async () => {
    const real = SessionSummarySchema.parse({ oneLineSummary: "Did a thing" });
    let calls = 0;
    const flaky = {
      summarize: async () => {
        calls++;
        if (calls > 1) throw new Error("summarizer died mid-batch");
        return real;
      },
    };
    const stored: SessionSummary[] = [];
    const vk = fakeValkey([
      { transcript: "first", meta: {} },
      { transcript: "second", meta: {} },
      { transcript: "third", meta: {} },
    ]);

    const pipeline = new AgingPipeline(
      vk.client as never,
      fakeStore(stored) as never,
      flaky as never,
    );
    const result = await pipeline.processIngestQueue();

    expect(result.processed).toBe(1);
    expect(stored.length).toBe(1);
    expect(vk.requeued.sort()).toEqual(["second", "third"]);
  });
});
