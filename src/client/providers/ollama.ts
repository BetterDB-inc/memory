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
    keep_alive: string;
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
   *
   * A cold model load is silent for longer than the idle timeout allows, but
   * the load keeps going server-side after the client gives up — so one
   * timed-out attempt is retried against the by-then warm model, and
   * keep_alive holds the model in memory between calls.
   */
  async summarize(transcript: string): Promise<SessionSummary> {
    let content: string;
    try {
      content = await this.chatSummary(transcript);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "TimeoutError")) {
        throw err;
      }
      content = await this.chatSummary(transcript);
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

  private async chatSummary(transcript: string): Promise<string> {
    const stream = await this.ollama.chat({
      model: this.preset.summarizeModel,
      messages: [
        { role: "user", content: buildSummarizePrompt(transcript) },
      ],
      format: "json",
      stream: true,
      keep_alive: "60m",
    });

    let content = "";
    for await (const chunk of stream) {
      content += chunk.message.content;
    }
    return content;
  }
}
