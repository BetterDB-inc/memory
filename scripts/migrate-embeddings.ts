#!/usr/bin/env bun
/**
 * Re-embeds all stored memories using the currently configured model.
 * Required after changing BETTERDB_EMBED_MODEL or BETTERDB_EMBED_DIM.
 *
 * Usage:
 *   bun run migrate-embeddings
 *   bun run migrate-embeddings -- --dry-run
 */
import { getValkeyClient } from "../src/client/valkey.js";
import { createModelClient } from "../src/client/model.js";
import { config } from "../src/config.js";

const dryRun = process.argv.includes("--dry-run");

const valkeyClient = await getValkeyClient();
const modelClient = await createModelClient();

const memoryIds = await valkeyClient.listMemoryIds();
console.log(`Found ${memoryIds.length} memories to migrate.`);
console.log(`Target model: ${modelClient.preset.embedModel} (dim=${modelClient.embedDim})`);

if (dryRun) {
  console.log("Dry run — no changes will be made.");
  await valkeyClient.quit();
  process.exit(0);
}

// Step 1: Drop existing index
console.log("Dropping existing index...");
await valkeyClient.dropIndex();

// Step 2: Update embed dimension metadata
const redis = await getValkeyClient();

// Step 3: Re-embed each memory
let processed = 0;
let failed = 0;

for (const id of memoryIds) {
  const memory = await valkeyClient.getMemory(id);
  if (!memory) {
    failed++;
    continue;
  }

  try {
    const newEmbedding = await modelClient.embed(memory.summary.oneLineSummary);
    await valkeyClient.storeMemory(memory, newEmbedding);
    processed++;
    if (processed % 10 === 0) {
      console.log(`Processed ${processed}/${memoryIds.length}...`);
    }
  } catch (err) {
    console.error(`Failed to re-embed memory ${id}:`, err);
    failed++;
  }
}

// Step 4: Recreate index with new dimension
console.log("Recreating index...");
await valkeyClient.ensureIndex(modelClient.embedDim);

console.log(`\nMigration complete:`);
console.log(`  Processed: ${processed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Index: ${config.valkey.indexName} (dim=${modelClient.embedDim})`);

await valkeyClient.quit();
