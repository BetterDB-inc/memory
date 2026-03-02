#!/usr/bin/env bun
/**
 * Standalone aging pipeline worker.
 * Runs decay, compression, and distillation on all stored memories.
 *
 * Can be run via cron, docker compose, or manually:
 *   bun run scripts/aging-worker.ts
 */
import { getValkeyClient } from "../src/client/valkey.js";
import { createModelClient } from "../src/client/model.js";
import { AgingPipeline } from "../src/memory/aging.js";

try {
  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();

  const pipeline = new AgingPipeline(valkeyClient, modelClient);
  await pipeline.runFullPipeline();

  await valkeyClient.quit();
} catch (err) {
  console.error("[betterdb] Aging worker failed:", err);
  process.exit(1);
}
