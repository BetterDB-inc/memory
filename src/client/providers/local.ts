import type { SessionSummary } from "../../memory/schema.js";
import type { ModelClient, ModelPreset } from "../model.js";

// On-device embeddings via @xenova/transformers — no API key, no running
// service. Weights (all-MiniLM-L6-v2, Apache-2.0, 384-dim) download once on
// first use and are cached under the transformers cache dir thereafter.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
  ): Promise<FeatureExtractor>;
}

// Lazy singleton: the model loads once and is reused across embed calls, and
// @xenova/transformers is only imported when local embeddings are actually used.
let extractorPromise: Promise<FeatureExtractor> | null = null;

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = import("@xenova/transformers").then((mod) =>
      (mod as unknown as TransformersModule).pipeline(
        "feature-extraction",
        MODEL_ID,
      ),
    );
  }
  return extractorPromise;
}

export class LocalEmbedClient implements ModelClient {
  readonly embedDim = EMBED_DIM;
  readonly preset: ModelPreset = {
    embedModel: MODEL_ID,
    summarizeModel: "n/a",
    embedDim: EMBED_DIM,
  };

  async embed(text: string): Promise<number[]> {
    const extract = await getExtractor();
    const output = await extract(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  async summarize(_transcript: string): Promise<SessionSummary> {
    throw new Error(
      "Local embeddings provider does not summarize — configure a summarize provider (Ollama, Anthropic, OpenAI, Groq, or Together)",
    );
  }
}
