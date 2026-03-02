import type { SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";

interface VoyageEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

export class VoyageEmbedClient implements ModelClient {
  private apiKey: string;
  readonly embedDim = 1024;
  readonly preset: ModelPreset = {
    embedModel: "voyage-3",
    summarizeModel: "n/a",
    embedDim: 1024,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "voyage-3", input: [text] }),
    });

    if (!response.ok) {
      throw new Error(`Voyage API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as VoyageEmbedResponse;
    const first = data.data[0];
    if (!first) {
      throw new Error("Voyage embed returned no embeddings");
    }
    return first.embedding;
  }

  async summarize(_transcript: string): Promise<SessionSummary> {
    throw new Error("Voyage AI does not provide summarization — configure a separate summarize provider");
  }
}
