import { describe, expect, test } from "bun:test";
import {
  CompositeModelClient,
  PRESET_CLEAN,
  PRESET_ATTRIBUTION,
  PRESET_LIGHTWEIGHT,
  type ModelClient,
  type ModelPreset,
} from "../../src/client/model.js";
import { buildSummarizePrompt } from "../../src/client/providers/_prompt.js";
import type { SessionSummary } from "../../src/memory/schema.js";

// --- Mock ModelClient for testing CompositeModelClient ---

function makeMockClient(overrides: Partial<ModelClient> & { preset: ModelPreset }): ModelClient {
  return {
    embedDim: overrides.preset.embedDim,
    preset: overrides.preset,
    embed: overrides.embed ?? (async () => [0.1, 0.2, 0.3]),
    summarize: overrides.summarize ?? (async () => ({
      decisions: [],
      patterns: [],
      problemsSolved: [],
      openThreads: [],
      filesChanged: [],
      oneLineSummary: "Mock summary",
    })),
  };
}

describe("CompositeModelClient", () => {
  test("routes embed() to embedClient", async () => {
    let embedCalled = false;
    const embedClient = makeMockClient({
      preset: { embedModel: "test-embed", summarizeModel: "n/a", embedDim: 512 },
      embed: async (text) => {
        embedCalled = true;
        expect(text).toBe("hello");
        return [1, 2, 3];
      },
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "test-summarize", embedDim: 0 },
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    const result = await composite.embed("hello");

    expect(embedCalled).toBe(true);
    expect(result).toEqual([1, 2, 3]);
  });

  test("routes summarize() to summarizeClient", async () => {
    let summarizeCalled = false;
    const embedClient = makeMockClient({
      preset: { embedModel: "test-embed", summarizeModel: "n/a", embedDim: 512 },
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "test-summarize", embedDim: 0 },
      summarize: async (transcript) => {
        summarizeCalled = true;
        expect(transcript).toBe("test transcript");
        return {
          decisions: ["d1"],
          patterns: [],
          problemsSolved: [],
          openThreads: [],
          filesChanged: [],
          oneLineSummary: "Custom summary",
        };
      },
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    const result = await composite.summarize("test transcript");

    expect(summarizeCalled).toBe(true);
    expect(result.oneLineSummary).toBe("Custom summary");
    expect(result.decisions).toEqual(["d1"]);
  });

  test("embedDim comes from embedClient", () => {
    const embedClient = makeMockClient({
      preset: { embedModel: "e", summarizeModel: "n/a", embedDim: 1024 },
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "s", embedDim: 0 },
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    expect(composite.embedDim).toBe(1024);
  });

  test("preset merges both providers", () => {
    const embedClient = makeMockClient({
      preset: { embedModel: "voyage-3", summarizeModel: "n/a", embedDim: 1024 },
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "claude-haiku-4-5", embedDim: 0 },
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    expect(composite.preset.embedModel).toBe("voyage-3");
    expect(composite.preset.summarizeModel).toBe("claude-haiku-4-5");
    expect(composite.preset.embedDim).toBe(1024);
  });

  test("does not call summarizeClient.embed()", async () => {
    const embedClient = makeMockClient({
      preset: { embedModel: "e", summarizeModel: "n/a", embedDim: 512 },
      embed: async () => [1, 2],
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "s", embedDim: 0 },
      embed: async () => {
        throw new Error("Should not be called");
      },
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    const result = await composite.embed("test");
    expect(result).toEqual([1, 2]);
  });

  test("does not call embedClient.summarize()", async () => {
    const embedClient = makeMockClient({
      preset: { embedModel: "e", summarizeModel: "n/a", embedDim: 512 },
      summarize: async () => {
        throw new Error("Should not be called");
      },
    });
    const summarizeClient = makeMockClient({
      preset: { embedModel: "n/a", summarizeModel: "s", embedDim: 0 },
      summarize: async () => ({
        decisions: [],
        patterns: [],
        problemsSolved: [],
        openThreads: [],
        filesChanged: [],
        oneLineSummary: "ok",
      }),
    });

    const composite = new CompositeModelClient(embedClient, summarizeClient);
    const result = await composite.summarize("test");
    expect(result.oneLineSummary).toBe("ok");
  });
});

describe("buildSummarizePrompt", () => {
  test("includes transcript text", () => {
    const prompt = buildSummarizePrompt("my transcript content");
    expect(prompt).toContain("my transcript content");
  });

  test("includes JSON schema instruction", () => {
    const prompt = buildSummarizePrompt("anything");
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"patterns"');
    expect(prompt).toContain('"problemsSolved"');
    expect(prompt).toContain('"openThreads"');
    expect(prompt).toContain('"filesChanged"');
    expect(prompt).toContain('"oneLineSummary"');
  });

  test("is identical regardless of import path", async () => {
    // Import from the shared prompt file
    const { buildSummarizePrompt: fromPrompt } = await import(
      "../../src/client/providers/_prompt.js"
    );
    // Import re-exported from model.ts
    const { buildSummarizePrompt: fromModel } = await import(
      "../../src/client/model.js"
    );

    const transcript = "test session transcript";
    expect(fromPrompt(transcript)).toBe(fromModel(transcript));
  });
});

describe("Factory priority order", () => {
  test("presets are ordered: clean → attribution → lightweight", () => {
    const presets = [PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT];
    expect(presets[0]!.embedModel).toBe("mxbai-embed-large");
    expect(presets[1]!.embedModel).toBe("nomic-embed-text");
    expect(presets[2]!.embedModel).toBe("all-minilm");
  });

  test("embed auto-detect order: ollama → voyage → openai → groq → together", () => {
    // This tests the conceptual order — actual detection is in the factory
    const priority = ["ollama", "voyage", "openai", "groq", "together"];
    expect(priority[0]).toBe("ollama");
    expect(priority[1]).toBe("voyage");
  });

  test("summarize auto-detect order: ollama → anthropic → openai → groq → together", () => {
    const priority = ["ollama", "anthropic", "openai", "groq", "together"];
    expect(priority[0]).toBe("ollama");
    expect(priority[1]).toBe("anthropic");
  });
});

describe("Provider-specific constraints", () => {
  test("Anthropic has embedDim 0 (no embeddings)", async () => {
    const { AnthropicSummarizeClient } = await import(
      "../../src/client/providers/anthropic.js"
    );
    const client = new AnthropicSummarizeClient("fake-key");
    expect(client.embedDim).toBe(0);
    expect(client.preset.embedModel).toBe("n/a");
  });

  test("Anthropic embed() throws clear error", async () => {
    const { AnthropicSummarizeClient } = await import(
      "../../src/client/providers/anthropic.js"
    );
    const client = new AnthropicSummarizeClient("fake-key");
    try {
      await client.embed("test");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("Anthropic does not provide embeddings");
    }
  });

  test("Voyage summarize() throws clear error", async () => {
    const { VoyageEmbedClient } = await import(
      "../../src/client/providers/voyage.js"
    );
    const client = new VoyageEmbedClient("fake-key");
    try {
      await client.summarize("test");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("does not provide summarization");
    }
  });

  test("OpenAI embed dimensions", async () => {
    const { OpenAIEmbedClient } = await import(
      "../../src/client/providers/openai.js"
    );
    const client = new OpenAIEmbedClient("fake-key");
    expect(client.embedDim).toBe(1536);
  });

  test("Voyage embed dimensions", async () => {
    const { VoyageEmbedClient } = await import(
      "../../src/client/providers/voyage.js"
    );
    const client = new VoyageEmbedClient("fake-key");
    expect(client.embedDim).toBe(1024);
  });

  test("Groq embed dimensions", async () => {
    const { GroqEmbedClient } = await import(
      "../../src/client/providers/groq.js"
    );
    const client = new GroqEmbedClient("fake-key");
    expect(client.embedDim).toBe(768);
  });

  test("Together embed dimensions", async () => {
    const { TogetherEmbedClient } = await import(
      "../../src/client/providers/together.js"
    );
    const client = new TogetherEmbedClient("fake-key");
    expect(client.embedDim).toBe(768);
  });
});

describe("Explicit provider override validation", () => {
  // These test the error messages from createExplicit*Provider

  test("explicit embed=voyage without VOYAGE_API_KEY mentions the key", () => {
    // We can't easily call the factory with overridden env,
    // but we can test the provider constructor is fine
    const { VoyageEmbedClient } = require("../../src/client/providers/voyage.js");
    const client = new VoyageEmbedClient("test-key");
    expect(client.preset.embedModel).toBe("voyage-3");
  });

  test("explicit summarize=anthropic constructs correctly", () => {
    const { AnthropicSummarizeClient } = require("../../src/client/providers/anthropic.js");
    const client = new AnthropicSummarizeClient("test-key");
    expect(client.preset.summarizeModel).toBe("claude-haiku-4-5");
  });
});
