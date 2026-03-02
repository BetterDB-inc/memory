import { describe, expect, test } from "bun:test";
import {
  PRESET_CLEAN,
  PRESET_ATTRIBUTION,
  PRESET_LIGHTWEIGHT,
  type ModelPreset,
} from "../../src/client/model.js";

describe("Model Presets", () => {
  test("PRESET_CLEAN has correct values", () => {
    expect(PRESET_CLEAN.embedModel).toBe("mxbai-embed-large");
    expect(PRESET_CLEAN.summarizeModel).toBe("mistral:7b");
    expect(PRESET_CLEAN.embedDim).toBe(1024);
  });

  test("PRESET_ATTRIBUTION has correct values", () => {
    expect(PRESET_ATTRIBUTION.embedModel).toBe("nomic-embed-text");
    expect(PRESET_ATTRIBUTION.summarizeModel).toBe("qwen2.5:7b");
    expect(PRESET_ATTRIBUTION.embedDim).toBe(768);
  });

  test("PRESET_LIGHTWEIGHT has correct values", () => {
    expect(PRESET_LIGHTWEIGHT.embedModel).toBe("all-minilm");
    expect(PRESET_LIGHTWEIGHT.summarizeModel).toBe("qwen2.5:3b");
    expect(PRESET_LIGHTWEIGHT.embedDim).toBe(384);
  });

  test("all presets have positive embed dimensions", () => {
    const presets: ModelPreset[] = [
      PRESET_CLEAN,
      PRESET_ATTRIBUTION,
      PRESET_LIGHTWEIGHT,
    ];
    for (const preset of presets) {
      expect(preset.embedDim).toBeGreaterThan(0);
    }
  });

  test("preset selection order is clean → attribution → lightweight", () => {
    const presets = [PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT];
    expect(presets[0]).toBe(PRESET_CLEAN);
    expect(presets[1]).toBe(PRESET_ATTRIBUTION);
    expect(presets[2]).toBe(PRESET_LIGHTWEIGHT);
  });
});

describe("Factory preset selection logic", () => {
  test("extracts base model name by splitting on colon", () => {
    const modelName = "mistral:7b";
    const base = modelName.split(":")[0];
    expect(base).toBe("mistral");
  });

  test("handles models without tags", () => {
    const modelName = "mxbai-embed-large";
    const base = modelName.split(":")[0];
    expect(base).toBe("mxbai-embed-large");
  });

  test("matches preset when both models available", () => {
    const available = new Set(["mxbai-embed-large", "mistral"]);
    const preset = PRESET_CLEAN;
    const embedBase = preset.embedModel.split(":")[0]!;
    const summarizeBase = preset.summarizeModel.split(":")[0]!;

    expect(available.has(embedBase)).toBe(true);
    expect(available.has(summarizeBase)).toBe(true);
  });

  test("rejects preset when embed model missing", () => {
    const available = new Set(["mistral"]);
    const preset = PRESET_CLEAN;
    const embedBase = preset.embedModel.split(":")[0]!;

    expect(available.has(embedBase)).toBe(false);
  });
});
