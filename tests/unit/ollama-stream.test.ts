import { describe, expect, test } from "bun:test";
import { OllamaModelClient } from "../../src/client/providers/ollama.js";

const PRESET = {
  embedModel: "mxbai-embed-large",
  summarizeModel: "mistral:7b",
  embedDim: 1024,
};

function chunked(pieces: string[]) {
  return {
    chat: async (request: { stream?: boolean }) => {
      expect(request.stream).toBe(true);
      async function* stream() {
        for (const piece of pieces) {
          yield { message: { content: piece } };
        }
      }
      return stream();
    },
    embed: async () => ({ embeddings: [[0]] }),
  };
}

function timeoutOnce(pieces: string[]) {
  let calls = 0;
  const requests: { keep_alive?: string }[] = [];
  return {
    requests,
    transport: {
      chat: async (request: { stream?: boolean; keep_alive?: string }) => {
        requests.push(request);
        calls++;
        if (calls === 1) {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        async function* stream() {
          for (const piece of pieces) {
            yield { message: { content: piece } };
          }
        }
        return stream();
      },
      embed: async () => ({ embeddings: [[0]] }),
    },
  };
}

describe("OllamaModelClient.summarize", () => {
  test("retries once when the cold model load outlives the fetch timeout", async () => {
    // A cold Ollama model load can exceed the client idle timeout; the load
    // continues server-side, so a single retry lands on a warm model.
    const json = JSON.stringify({ oneLineSummary: "Recovered" });
    const fake = timeoutOnce([json]);

    const client = new OllamaModelClient(PRESET, undefined, fake.transport);
    const summary = await client.summarize("User: transcript");

    expect(summary.oneLineSummary).toBe("Recovered");
    expect(fake.requests.length).toBe(2);
  });

  test("keeps the model warm across calls via keep_alive", async () => {
    const json = JSON.stringify({ oneLineSummary: "Recovered" });
    const fake = timeoutOnce([json]);

    const client = new OllamaModelClient(PRESET, undefined, fake.transport);
    await client.summarize("User: transcript");

    for (const request of fake.requests) {
      expect(request.keep_alive).toBe("60m");
    }
  });

  test("assembles the summary from streamed chunks", async () => {
    // Streaming keeps bytes flowing during generation so Bun's fetch idle
    // timeout cannot fire while the model is still producing output.
    const json = JSON.stringify({ oneLineSummary: "Did a thing" });
    const mid = Math.floor(json.length / 2);
    const transport = chunked([json.slice(0, mid), json.slice(mid)]);

    const client = new OllamaModelClient(PRESET, undefined, transport);
    const summary = await client.summarize("User: did we do a thing?");

    expect(summary.oneLineSummary).toBe("Did a thing");
  });
});
