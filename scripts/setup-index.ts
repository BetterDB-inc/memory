#!/usr/bin/env bun
import { getValkeyClient } from "../src/client/valkey.js";
import { getPluginMemoryStore } from "../src/client/memory-store.js";
import { createModelClient } from "../src/client/model.js";

const client = await getValkeyClient();
const modelClient = await createModelClient();

// Create the episodic vector index that MemoryStore reads/writes
// (betterdb:mem:idx) — the same one `install` builds. Record the active
// provider/dimension first so a later provider swap is caught.
await client.assertEmbedDim(modelClient.embedDim, modelClient.preset.embedModel);
const store = await getPluginMemoryStore((t) => modelClient.embed(t));
await store.ensureIndex();

console.log("Index ready: betterdb:mem:idx");
console.log("Embedding dimension:", modelClient.embedDim);
console.log("Preset:", modelClient.preset.embedModel, "/", modelClient.preset.summarizeModel);

await store.close();
await client.quit();
