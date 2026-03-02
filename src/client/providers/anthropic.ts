import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";

interface AnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export class AnthropicSummarizeClient implements ModelClient {
  private client: AnthropicClient | null = null;
  private apiKey: string;
  readonly embedDim = 0;
  readonly preset: ModelPreset = {
    embedModel: "n/a",
    summarizeModel: "claude-haiku-4-5",
    embedDim: 0,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<AnthropicClient> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey }) as unknown as AnthropicClient;
    }
    return this.client;
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error(
      "Anthropic does not provide embeddings — configure a separate embed provider",
    );
  }

  async summarize(transcript: string): Promise<SessionSummary> {
    const client = await this.getClient();
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const content = textBlock?.text;
    if (!content) {
      console.error("[betterdb] Anthropic summarization returned empty response");
      return SessionSummarySchema.parse({});
    }

    const parsed = SessionSummarySchema.safeParse(JSON.parse(stripCodeFences(content)));
    if (!parsed.success) {
      console.error("[betterdb] Failed to parse Anthropic summarization:", parsed.error.message);
      return SessionSummarySchema.parse({});
    }

    return parsed.data;
  }
}
