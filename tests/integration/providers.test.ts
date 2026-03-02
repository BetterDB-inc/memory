import { describe, expect, test } from "bun:test";
import { SessionSummarySchema } from "../../src/memory/schema.js";
import { config } from "../../src/config.js";

const SKIP = Bun.env.BETTERDB_SKIP_INTEGRATION === "true";

describe.skipIf(SKIP)("Provider integration", () => {
  // --- OpenAI ---
  describe.skipIf(!config.providers.openaiKey)("OpenAI", () => {
    test("embed returns correct dimension", async () => {
      const { OpenAIEmbedClient } = await import("../../src/client/providers/openai.js");
      const client = new OpenAIEmbedClient(config.providers.openaiKey!);

      const start = performance.now();
      const result = await client.embed("BetterDB integration test");
      const ms = performance.now() - start;

      console.error(`  OpenAI embed: ${result.length} dims, ${ms.toFixed(0)}ms`);
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(1536);
      expect(typeof result[0]).toBe("number");
    });

    test("summarize returns valid SessionSummary", async () => {
      const { OpenAISummarizeClient } = await import("../../src/client/providers/openai.js");
      const client = new OpenAISummarizeClient(config.providers.openaiKey!);

      const start = performance.now();
      const result = await client.summarize("User asked to fix a bug in the login form. Fixed the null check on email field.");
      const ms = performance.now() - start;

      console.error(`  OpenAI summarize: "${result.oneLineSummary}", ${ms.toFixed(0)}ms`);
      const parsed = SessionSummarySchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });

  // --- Anthropic ---
  describe.skipIf(!config.providers.anthropicKey)("Anthropic", () => {
    test("summarize returns valid SessionSummary", async () => {
      const { AnthropicSummarizeClient } = await import("../../src/client/providers/anthropic.js");
      const client = new AnthropicSummarizeClient(config.providers.anthropicKey!);

      const start = performance.now();
      const result = await client.summarize("User asked to add pagination. Implemented cursor-based pagination in the API.");
      const ms = performance.now() - start;

      console.error(`  Anthropic summarize: "${result.oneLineSummary}", ${ms.toFixed(0)}ms`);
      const parsed = SessionSummarySchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    test("embed throws clear error", async () => {
      const { AnthropicSummarizeClient } = await import("../../src/client/providers/anthropic.js");
      const client = new AnthropicSummarizeClient(config.providers.anthropicKey!);

      try {
        await client.embed("test");
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("does not provide embeddings");
      }
    });
  });

  // --- Voyage ---
  describe.skipIf(!config.providers.voyageKey)("Voyage AI", () => {
    test("embed returns correct dimension", async () => {
      const { VoyageEmbedClient } = await import("../../src/client/providers/voyage.js");
      const client = new VoyageEmbedClient(config.providers.voyageKey!);

      const start = performance.now();
      const result = await client.embed("BetterDB integration test");
      const ms = performance.now() - start;

      console.error(`  Voyage embed: ${result.length} dims, ${ms.toFixed(0)}ms`);
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(1024);
    });
  });

  // --- Groq ---
  describe.skipIf(!config.providers.groqKey)("Groq", () => {
    test("summarize returns valid SessionSummary", async () => {
      const { GroqSummarizeClient } = await import("../../src/client/providers/groq.js");
      const client = new GroqSummarizeClient(config.providers.groqKey!);

      const start = performance.now();
      const result = await client.summarize("User refactored the database module. Extracted connection pooling into a separate class.");
      const ms = performance.now() - start;

      console.error(`  Groq summarize: "${result.oneLineSummary}", ${ms.toFixed(0)}ms`);
      const parsed = SessionSummarySchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });

  // --- Together ---
  describe.skipIf(!config.providers.togetherKey)("Together AI", () => {
    test("embed returns correct dimension", async () => {
      const { TogetherEmbedClient } = await import("../../src/client/providers/together.js");
      const client = new TogetherEmbedClient(config.providers.togetherKey!);

      const start = performance.now();
      const result = await client.embed("BetterDB integration test");
      const ms = performance.now() - start;

      console.error(`  Together embed: ${result.length} dims, ${ms.toFixed(0)}ms`);
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(768);
    });

    test("summarize returns valid SessionSummary", async () => {
      const { TogetherSummarizeClient } = await import("../../src/client/providers/together.js");
      const client = new TogetherSummarizeClient(config.providers.togetherKey!);

      const start = performance.now();
      const result = await client.summarize("User added error handling to the API endpoints.");
      const ms = performance.now() - start;

      console.error(`  Together summarize: "${result.oneLineSummary}", ${ms.toFixed(0)}ms`);
      const parsed = SessionSummarySchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });
});
