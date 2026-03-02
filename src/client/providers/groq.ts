import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";
import { createOpenAI, type OpenAIClient } from "./openai.js";

export class GroqEmbedClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 768;
  readonly preset: ModelPreset = {
    embedModel: "nomic-embed-text-v1_5",
    summarizeModel: "n/a",
    embedDim: 768,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey, "https://api.groq.com/openai/v1");
    }
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.getClient();
    try {
      const response = await client.embeddings.create({
        model: "nomic-embed-text-v1_5",
        input: text,
      });
      const first = response.data[0];
      if (!first) {
        throw new Error("Groq embed returned no embeddings");
      }
      return first.embedding;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404") || message.includes("not found")) {
        throw new Error("Groq embedding API unavailable — try a different embed provider");
      }
      throw err;
    }
  }

  async summarize(_transcript: string): Promise<SessionSummary> {
    throw new Error("GroqEmbedClient does not support summarization — use GroqSummarizeClient");
  }
}

export class GroqSummarizeClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 0;
  readonly preset: ModelPreset = {
    embedModel: "n/a",
    summarizeModel: "llama-3.1-8b-instant",
    embedDim: 0,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey, "https://api.groq.com/openai/v1");
    }
    return this.client;
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("GroqSummarizeClient does not support embedding — use GroqEmbedClient");
  }

  async summarize(transcript: string): Promise<SessionSummary> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      console.error("[betterdb] Groq summarization returned empty response");
      return SessionSummarySchema.parse({});
    }

    const parsed = SessionSummarySchema.safeParse(JSON.parse(stripCodeFences(content)));
    if (!parsed.success) {
      console.error("[betterdb] Failed to parse Groq summarization:", parsed.error.message);
      return SessionSummarySchema.parse({});
    }

    return parsed.data;
  }
}
