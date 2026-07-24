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

describe("OllamaModelClient.summarize", () => {
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
