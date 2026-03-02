import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";
import { createOpenAI, type OpenAIClient } from "./openai.js";

export class TogetherEmbedClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 768;
  readonly preset: ModelPreset = {
    embedModel: "togethercomputer/m2-bert-80M-8k-retrieval",
    summarizeModel: "n/a",
    embedDim: 768,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey, "https://api.together.xyz/v1");
    }
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.getClient();
    const response = await client.embeddings.create({
      model: "togethercomputer/m2-bert-80M-8k-retrieval",
      input: text,
    });
    const first = response.data[0];
    if (!first) {
      throw new Error("Together AI embed returned no embeddings");
    }
    return first.embedding;
  }

  async summarize(_transcript: string): Promise<SessionSummary> {
    throw new Error("TogetherEmbedClient does not support summarization — use TogetherSummarizeClient");
  }
}

export class TogetherSummarizeClient implements ModelClient {
  private client: OpenAIClient | null = null;
  private apiKey: string;
  readonly embedDim = 0;
  readonly preset: ModelPreset = {
    embedModel: "n/a",
    summarizeModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    embedDim: 0,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      this.client = await createOpenAI(this.apiKey, "https://api.together.xyz/v1");
    }
    return this.client;
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error("TogetherSummarizeClient does not support embedding — use TogetherEmbedClient");
  }

  async summarize(transcript: string): Promise<SessionSummary> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      console.error("[betterdb] Together AI summarization returned empty response");
      return SessionSummarySchema.parse({});
    }

    const parsed = SessionSummarySchema.safeParse(JSON.parse(stripCodeFences(content)));
    if (!parsed.success) {
      console.error("[betterdb] Failed to parse Together AI summarization:", parsed.error.message);
      return SessionSummarySchema.parse({});
    }

    return parsed.data;
  }
}
