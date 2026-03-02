import { Ollama } from "ollama";
import { config } from "../../config.js";
import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";

export class OllamaModelClient implements ModelClient {
  private ollama: Ollama;
  readonly preset: ModelPreset;
  readonly embedDim: number;

  constructor(preset: ModelPreset, ollamaUrl?: string) {
    this.ollama = new Ollama({ host: ollamaUrl ?? config.ollama.url });
    this.preset = preset;
    this.embedDim = preset.embedDim;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.ollama.embed({
      model: this.preset.embedModel,
      input: text,
    });
    const first = response.embeddings[0];
    if (!first) {
      throw new Error("Ollama embed returned no embeddings");
    }
    return first;
  }

  async summarize(transcript: string): Promise<SessionSummary> {
    const response = await this.ollama.chat({
      model: this.preset.summarizeModel,
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      format: "json",
    });

    const parsed = SessionSummarySchema.safeParse(
      JSON.parse(stripCodeFences(response.message.content)),
    );

    if (!parsed.success) {
      console.error(
        "[betterdb] Failed to parse Ollama summarization response:",
        parsed.error.message,
      );
      return SessionSummarySchema.parse({});
    }

    return parsed.data;
  }
}
