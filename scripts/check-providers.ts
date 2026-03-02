#!/usr/bin/env bun
/**
 * Checks which providers are available and prints a summary.
 *
 * Usage:
 *   bun run check-providers
 *   bun run check-providers -- --test   (makes live API calls)
 */
import { Ollama } from "ollama";
import { config } from "../src/config.js";
import { createModelClient } from "../src/client/model.js";
import { PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT } from "../src/client/model.js";

const testMode = process.argv.includes("--test");

console.log("BetterDB Provider Check");
console.log("─────────────────────────────");

// --- Ollama ---
let ollamaModels: Set<string> = new Set();
try {
  const ollama = new Ollama({ host: config.ollama.url });
  const list = await ollama.list();
  ollamaModels = new Set(list.models.map((m) => m.name.split(":")[0]!));

  const presets = [PRESET_CLEAN, PRESET_ATTRIBUTION, PRESET_LIGHTWEIGHT];
  const modelChecks: string[] = [];
  for (const preset of presets) {
    const embedBase = preset.embedModel.split(":")[0]!;
    const summarizeBase = preset.summarizeModel.split(":")[0]!;
    if (ollamaModels.has(embedBase)) modelChecks.push(`${preset.embedModel} ✓`);
    if (ollamaModels.has(summarizeBase)) modelChecks.push(`${preset.summarizeModel} ✓`);
  }

  const modelStr = modelChecks.length > 0 ? ` (${modelChecks.join(", ")})` : "";
  console.log(`  Ollama        ✓ running${modelStr}`);
} catch {
  console.log("  Ollama        ✗ not running");
}

// --- API Key Providers ---
const providers = [
  { name: "OpenAI", key: config.providers.openaiKey },
  { name: "Anthropic", key: config.providers.anthropicKey },
  { name: "Voyage", key: config.providers.voyageKey },
  { name: "Groq", key: config.providers.groqKey },
  { name: "Together", key: config.providers.togetherKey },
] as const;

for (const p of providers) {
  const status = p.key ? "✓ key set" : "✗ no key";
  console.log(`  ${p.name.padEnd(14)}${status}`);
}

// --- Resolved Configuration ---
console.log("");
try {
  const client = await createModelClient();
  console.log("Resolved configuration:");
  console.log(`  Embed:      ${client.preset.embedModel} (dim=${client.embedDim})`);
  console.log(`  Summarize:  ${client.preset.summarizeModel}`);
} catch (err) {
  console.log("Resolution failed:");
  console.log(`  ${err instanceof Error ? err.message : String(err)}`);
}

// --- Live Test ---
if (testMode) {
  console.log("");
  console.log("Live API tests:");
  console.log("─────────────────────────────");

  try {
    const client = await createModelClient();

    // Embed test
    const embedStart = performance.now();
    try {
      const embedding = await client.embed("BetterDB provider test");
      const embedMs = (performance.now() - embedStart).toFixed(0);
      console.log(`  Embed:      ✓ ${embedding.length} dims, ${embedMs}ms`);
    } catch (err) {
      const embedMs = (performance.now() - embedStart).toFixed(0);
      console.log(`  Embed:      ✗ ${err instanceof Error ? err.message : String(err)} (${embedMs}ms)`);
    }

    // Summarize test
    const sumStart = performance.now();
    try {
      const summary = await client.summarize("User asked to add a login button. Added onClick handler to LoginForm component.");
      const sumMs = (performance.now() - sumStart).toFixed(0);
      console.log(`  Summarize:  ✓ "${summary.oneLineSummary}" (${sumMs}ms)`);
    } catch (err) {
      const sumMs = (performance.now() - sumStart).toFixed(0);
      console.log(`  Summarize:  ✗ ${err instanceof Error ? err.message : String(err)} (${sumMs}ms)`);
    }
  } catch (err) {
    console.log(`  ✗ Cannot test — provider resolution failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  console.log("");
  console.log("Run 'bun run check-providers --test' to make a live API call to each available provider.");
}
