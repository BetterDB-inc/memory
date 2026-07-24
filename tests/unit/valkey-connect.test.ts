import { afterAll, describe, expect, test } from "bun:test";
import { connectValkey } from "../../src/client/valkey.js";

// A listener that accepts connections and never speaks RESP — the same shape
// as Docker's proxy accepting for a backend that is not there. Hooks run on
// every tool call, so a connect against this must fail fast, not hang until
// the hook harness kills the process.
const blackhole = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data() {},
  },
});

afterAll(() => {
  blackhole.stop(true);
});

describe("connectValkey against an unresponsive server", () => {
  test("fails within the deadline instead of hanging", async () => {
    const started = Date.now();

    await expect(
      connectValkey(`redis://127.0.0.1:${blackhole.port}`, 1000),
    ).rejects.toThrow(/deadline exceeded/);

    expect(Date.now() - started).toBeLessThan(3000);
  }, 30_000);
});
