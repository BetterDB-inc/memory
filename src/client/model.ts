import { Ollama } from "ollama";
import { config } from "../config.js";
import type { SessionSummary } from "../memory/schema.js";

// --- Model Presets ---

export interface ModelPreset {
  embedModel: string;
  summarizeModel: string;
  embedDim: number;
}

export const PRESET_CLEAN: ModelPreset = {
  embedModel: "mxbai-embed-large",
  summarizeModel: "mistral:7b",
  embedDim: 1024,
};

export const PRESET_ATTRIBUTION: ModelPreset = {
  embedModel: "nomic-embed-text",
  summarizeModel: "qwen2.5:7b",
  embedDim: 768,
};

export const PRESET_LIGHTWEIGHT: ModelPreset = {
  embedModel: "all-minilm",
  summarizeModel: "qwen2.5:3b",
  embedDim: 384,
};

// --- ModelClient Interface ---

export interface ModelClient {
  embed(text: string): Promise<number[]>;
  summarize(transcript: string): Promise<SessionSummary>;
  readonly embedDim: number;
  readonly preset: ModelPreset;
}

// --- Composite Model Client ---

export class CompositeModelClient implements ModelClient {
  constructor(
    private readonly embedClient: ModelClient,
    private readonly summarizeClient: ModelClient,
  ) {}

  embed(text: string): Promise<number[]> {
    return this.embedClient.embed(text);
  }

  summarize(transcript: string): Promise<SessionSummary> {
    return this.summarizeClient.summarize(transcript);
  }

  get embedDim(): number {
    return this.embedClient.embedDim;
  }

  get preset(): ModelPreset {
    return {
      embedModel: this.embedClient.preset.embedModel,
      summarizeModel: this.summarizeClient.preset.summarizeModel,
      embedDim: this.embedClient.embedDim,
    };
  }
}

// --- Re-exports ---

export { OllamaModelClient } from "./providers/ollama.js";
export { OpenAIEmbedClient, OpenAISummarizeClient } from "./providers/openai.js";
export { AnthropicSummarizeClient } from "./providers/anthropic.js";
export { VoyageEmbedClient } from "./providers/voyage.js";
export { GroqEmbedClient, GroqSummarizeClient } from "./providers/groq.js";
export { TogetherEmbedClient, TogetherSummarizeClient } from "./providers/together.js";
export { buildSummarizePrompt } from "./providers/_prompt.js";

// --- Provider Detection ---

async function detectOllamaModels(): Promise<Set<string>> {
  try {
    const ollama = new Ollama({ host: config.ollama.url });
    const listResponse = await ollama.list();
    return new Set(listResponse.models.map((m) => m.name.split(":")[0]!));
  } catch {
    return new Set();
  }
}

// --- Factory ---

export async function createModelClient(): Promise<ModelClient> {
  const p = config.providers;

  const embedClient = await resolveEmbedProvider(p);
  const summarizeClient = await resolveSummarizeProvider(p);

  console.error(
    `[betterdb] embed=${embedClient.preset.embedModel} summarize=${summarizeClient.preset.summarizeModel}`,
  );

  return new CompositeModelClient(embedClient, summarizeClient);
}

async function resolveEmbedProvider(
  p: typeof config.providers,
): Promise<ModelClient> {
  // Explicit override
  if (p.embedProvider) {
    return createExplicitEmbedProvider(p.embedProvider, p);
  }

  // Auto-detect: Ollama first
  const ollamaModels = await detectOllamaModels();
  const presets = [PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT];
  for (const preset of presets) {
    const base = preset.embedModel.split(":")[0]!;
    if (ollamaModels.has(base)) {
      const { OllamaModelClient } = await import("./providers/ollama.js");
      return new OllamaModelClient(preset, config.ollama.url);
    }
  }

  // Voyage
  if (p.voyageKey) {
    const { VoyageEmbedClient } = await import("./providers/voyage.js");
    return new VoyageEmbedClient(p.voyageKey);
  }

  // OpenAI
  if (p.openaiKey) {
    const { OpenAIEmbedClient } = await import("./providers/openai.js");
    return new OpenAIEmbedClient(p.openaiKey);
  }

  // Groq
  if (p.groqKey) {
    const { GroqEmbedClient } = await import("./providers/groq.js");
    return new GroqEmbedClient(p.groqKey);
  }

  // Together
  if (p.togetherKey) {
    const { TogetherEmbedClient } = await import("./providers/together.js");
    return new TogetherEmbedClient(p.togetherKey);
  }

  throw new Error(
    `No embedding provider available. Options:\n` +
      `  1. Install Ollama and run: ollama pull mxbai-embed-large\n` +
      `  2. Set VOYAGE_API_KEY for Voyage AI (voyage-3, dim=1024)\n` +
      `  3. Set OPENAI_API_KEY for OpenAI (text-embedding-3-small, dim=1536)\n` +
      `  4. Set GROQ_API_KEY for Groq (nomic-embed-text-v1_5, dim=768)\n` +
      `  5. Set TOGETHER_API_KEY for Together AI (m2-bert-80M-8k-retrieval, dim=768)\n\n` +
      `Note: ANTHROPIC_API_KEY does not provide embeddings — pair it with another embed provider.`,
  );
}

async function resolveSummarizeProvider(
  p: typeof config.providers,
): Promise<ModelClient> {
  // Explicit override
  if (p.summarizeProvider) {
    return createExplicitSummarizeProvider(p.summarizeProvider, p);
  }

  // Auto-detect: Ollama first
  const ollamaModels = await detectOllamaModels();
  const presets = [PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT];
  for (const preset of presets) {
    const base = preset.summarizeModel.split(":")[0]!;
    if (ollamaModels.has(base)) {
      const { OllamaModelClient } = await import("./providers/ollama.js");
      return new OllamaModelClient(preset, config.ollama.url);
    }
  }

  // Anthropic
  if (p.anthropicKey) {
    const { AnthropicSummarizeClient } = await import("./providers/anthropic.js");
    return new AnthropicSummarizeClient(p.anthropicKey);
  }

  // OpenAI
  if (p.openaiKey) {
    const { OpenAISummarizeClient } = await import("./providers/openai.js");
    return new OpenAISummarizeClient(p.openaiKey);
  }

  // Groq
  if (p.groqKey) {
    const { GroqSummarizeClient } = await import("./providers/groq.js");
    return new GroqSummarizeClient(p.groqKey);
  }

  // Together
  if (p.togetherKey) {
    const { TogetherSummarizeClient } = await import("./providers/together.js");
    return new TogetherSummarizeClient(p.togetherKey);
  }

  throw new Error(
    `No summarization provider available. Options:\n` +
      `  1. Install Ollama and run: ollama pull mistral:7b\n` +
      `  2. Set ANTHROPIC_API_KEY for Anthropic (claude-haiku-4-5)\n` +
      `  3. Set OPENAI_API_KEY for OpenAI (gpt-4o-mini)\n` +
      `  4. Set GROQ_API_KEY for Groq (llama-3.1-8b-instant)\n` +
      `  5. Set TOGETHER_API_KEY for Together AI (Meta-Llama-3.1-8B-Instruct-Turbo)`,
  );
}

// --- Explicit Provider Constructors ---

function createExplicitEmbedProvider(
  name: string,
  p: typeof config.providers,
): ModelClient {
  switch (name) {
    case "ollama": {
      const { OllamaModelClient } = require("./providers/ollama.js");
      return new OllamaModelClient(PRESET_CLEAN, config.ollama.url);
    }
    case "openai": {
      if (!p.openaiKey) throw new Error("BETTERDB_EMBED_PROVIDER=openai but OPENAI_API_KEY is not set");
      const { OpenAIEmbedClient } = require("./providers/openai.js");
      return new OpenAIEmbedClient(p.openaiKey);
    }
    case "voyage": {
      if (!p.voyageKey) throw new Error("BETTERDB_EMBED_PROVIDER=voyage but VOYAGE_API_KEY is not set");
      const { VoyageEmbedClient } = require("./providers/voyage.js");
      return new VoyageEmbedClient(p.voyageKey);
    }
    case "groq": {
      if (!p.groqKey) throw new Error("BETTERDB_EMBED_PROVIDER=groq but GROQ_API_KEY is not set");
      const { GroqEmbedClient } = require("./providers/groq.js");
      return new GroqEmbedClient(p.groqKey);
    }
    case "together": {
      if (!p.togetherKey) throw new Error("BETTERDB_EMBED_PROVIDER=together but TOGETHER_API_KEY is not set");
      const { TogetherEmbedClient } = require("./providers/together.js");
      return new TogetherEmbedClient(p.togetherKey);
    }
    default:
      throw new Error(`Unknown embed provider: ${name}. Valid: ollama, openai, voyage, groq, together`);
  }
}

function createExplicitSummarizeProvider(
  name: string,
  p: typeof config.providers,
): ModelClient {
  switch (name) {
    case "ollama": {
      const { OllamaModelClient } = require("./providers/ollama.js");
      return new OllamaModelClient(PRESET_CLEAN, config.ollama.url);
    }
    case "openai": {
      if (!p.openaiKey) throw new Error("BETTERDB_SUMMARIZE_PROVIDER=openai but OPENAI_API_KEY is not set");
      const { OpenAISummarizeClient } = require("./providers/openai.js");
      return new OpenAISummarizeClient(p.openaiKey);
    }
    case "anthropic": {
      if (!p.anthropicKey) throw new Error("BETTERDB_SUMMARIZE_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
      const { AnthropicSummarizeClient } = require("./providers/anthropic.js");
      return new AnthropicSummarizeClient(p.anthropicKey);
    }
    case "groq": {
      if (!p.groqKey) throw new Error("BETTERDB_SUMMARIZE_PROVIDER=groq but GROQ_API_KEY is not set");
      const { GroqSummarizeClient } = require("./providers/groq.js");
      return new GroqSummarizeClient(p.groqKey);
    }
    case "together": {
      if (!p.togetherKey) throw new Error("BETTERDB_SUMMARIZE_PROVIDER=together but TOGETHER_API_KEY is not set");
      const { TogetherSummarizeClient } = require("./providers/together.js");
      return new TogetherSummarizeClient(p.togetherKey);
    }
    default:
      throw new Error(`Unknown summarize provider: ${name}. Valid: ollama, openai, anthropic, groq, together`);
  }
}
