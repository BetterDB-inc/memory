#!/usr/bin/env bun
import { getValkeyClient } from "../src/client/valkey.js";
import { createModelClient } from "../src/client/model.js";
import { config } from "../src/config.js";

const client = await getValkeyClient();
const modelClient = await createModelClient();

await client.ensureIndex(modelClient.embedDim, modelClient.preset.embedModel);
console.log("Index ready:", config.valkey.indexName);
console.log("Embedding dimension:", modelClient.embedDim);
console.log("Preset:", modelClient.preset.embedModel, "/", modelClient.preset.summarizeModel);

await client.quit();
