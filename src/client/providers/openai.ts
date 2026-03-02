import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";

interface OpenAIClient {
  embeddings: {
    create(params: {
      model: string;
      input: string;
    }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format: { type: string };
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

async function createOpenAI(apiKey: string, baseURL?: string): Promise<OpenAIClient> {
  // @ts-expect-error — openai is an optional dependency, lazy-loaded
  const { default: OpenAI } = await import("openai");
  return new (OpenAI as new (opts: { apiKey: string; baseURL?: string }) => OpenAIClient)({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

export class OpenAIEmbedClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 1536;
  readonly preset: ModelPreset = {
    embedModel: "text-embedding-3-small",
    summarizeModel: "n/a",
    embedDim: 1536,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey);
    }
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.getClient();
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    const first = response.data[0];
    if (!first) {
      throw new Error("OpenAI embed returned no embeddings");
    }
    return first.embedding;
  }

  async summarize(_transcript: string): Promise<SessionSummary> {
    throw new Error("OpenAIEmbedClient does not support summarization — use OpenAISummarizeClient");
  }
}

export class OpenAISummarizeClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 0;
  readonly preset: ModelPreset = {
    embedModel: "n/a",
    summarizeModel: "gpt-4o-mini",
    embedDim: 0,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey);
    }
    return this.client;
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("OpenAISummarizeClient does not support embedding — use OpenAIEmbedClient");
  }

  async summarize(transcript: string): Promise<SessionSummary> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      console.error("[betterdb] OpenAI summarization returned empty response");
      return SessionSummarySchema.parse({});
    }

    const parsed = SessionSummarySchema.safeParse(JSON.parse(stripCodeFences(content)));
    if (!parsed.success) {
      console.error("[betterdb] Failed to parse OpenAI summarization:", parsed.error.message);
      return SessionSummarySchema.parse({});
    }

    return parsed.data;
  }
}

// Re-export the helper for Groq and Together providers
export { createOpenAI, type OpenAIClient };
