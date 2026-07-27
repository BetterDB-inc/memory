import { getValkeyClient } from "../client/valkey.js";
import { getPluginMemoryStore } from "../client/memory-store.js";
import { createModelClient } from "../client/model.js";
import { AgingPipeline } from "../memory/aging.js";
import { isConfigured } from "../config.js";

// Detached drainer: summarizes and stores whatever the SessionEnd hook queued.
// Runs as its own process precisely so the LLM call is not on a hook's clock —
// nothing waits for this.
async function main(): Promise<void> {
  if (!isConfigured()) {
    return;
  }

  const valkeyClient = await getValkeyClient();
  const modelClient = await createModelClient();
  const store = await getPluginMemoryStore((t) => modelClient.embed(t));
  const pipeline = new AgingPipeline(valkeyClient, store, modelClient);

  const { processed, skipped } = await pipeline.drainIngestQueue();
  console.error(`[betterdb] drain: processed=${processed} skipped=${skipped}`);

  await store.close();
  await valkeyClient.quit();
}

main()
  .catch((err: unknown) => {
    console.error(
      "[betterdb] drain failed:",
      err instanceof Error ? err.message : String(err),
    );
  })
  .finally(() => {
    process.exit(0);
  });
