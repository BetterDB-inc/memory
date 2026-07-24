import { Ollama } from "ollama";
import { config } from "../../config.js";
import { SessionSummarySchema, type SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";
import { buildSummarizePrompt, stripCodeFences } from "./_prompt.js";

export interface OllamaTransport {
  chat(request: {
    model: string;
    messages: { role: string; content: string }[];
    format: string;
    stream: true;
  }): Promise<AsyncIterable<{ message: { content: string } }>>;
  embed(request: {
    model: string;
    input: string;
  }): Promise<{ embeddings: number[][] }>;
}

export class OllamaModelClient implements ModelClient {
  private ollama: OllamaTransport;
  readonly preset: ModelPreset;
  readonly embedDim: number;

  constructor(
    preset: ModelPreset,
    ollamaUrl?: string,
    transport?: OllamaTransport,
  ) {
    this.ollama =
      transport ?? new Ollama({ host: ollamaUrl ?? config.ollama.url });
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

  /**
   * Streamed rather than awaited whole: Bun's fetch enforces an idle timeout,
   * and a non-streaming generate sends no bytes until the entire summary is
   * done — long generations died as TimeoutError. Chunks keep the connection
   * alive for as long as the model keeps producing.
   */
  async summarize(transcript: string): Promise<SessionSummary> {
    const stream = await this.ollama.chat({
      model: this.preset.summarizeModel,
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      format: "json",
      stream: true,
    });

    let content = "";
    for await (const chunk of stream) {
      content += chunk.message.content;
    }

    const parsed = SessionSummarySchema.safeParse(
      JSON.parse(stripCodeFences(content)),
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
