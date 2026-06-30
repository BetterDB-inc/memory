#!/usr/bin/env bun
/**
 * Standalone aging pipeline worker.
 * Runs decay, compression, and distillation on all stored memories.
 *
 * Can be run via cron, docker compose, or manually:
 *   bun run scripts/aging-worker.ts
 */
import { getValkeyClient } from "../src/client/valkey.js";
import { getPluginMemoryStore } from "../src/client/memory-store.js";
import { createModelClient } from "../src/client/model.js";
import { AgingPipeline } from "../src/memory/aging.js";

try {
  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));

  const pipeline = new AgingPipeline(valkeyClient, store, modelClient);
  await pipeline.runFullPipeline();

  await store.close();
  await valkeyClient.quit();
} catch (err) {
  console.error("[betterdb] Aging worker failed:", err);
  process.exit(1);
}
