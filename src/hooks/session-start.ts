import { readRawPayload, runHook } from "./_utils.js";
import { getValkeyClient } from "../client/valkey.js";
import { createModelClient } from "../client/model.js";
import { SessionCapture } from "../memory/capture.js";
import { MemoryRetriever, formatForInjection } from "../memory/retrieval.js";
import { config, isConfigured } from "../config.js";

/**
 * SessionStart hook: Retrieves relevant memories and injects context.
 *
 * Claude Code hooks contract:
 * - Receives JSON on stdin with session_id, cwd, transcript_path
 * - stdout text is added to Claude's context
 * - Exit 0 for success
 */
runHook(async () => {
  if (!isConfigured()) {
    process.stdout.write(
      "[BetterDB Memory] Not configured yet. Run /betterdb-memory:setup to connect to Valkey.\n",
    );
    return;
  }

  const payload = await readRawPayload();
  const cwd = (payload["cwd"] as string) ?? process.cwd();

  if (cwd) {
    process.chdir(cwd);
  }

  let valkeyClient;
  try {
    valkeyClient = await getValkeyClient();
  } catch {
    return; // Valkey unreachable — skip silently
  }

  const modelClient = await createModelClient();

  const capture = new SessionCapture();
  const queryContext = await capture.getQueryContext();

  const retriever = new MemoryRetriever(valkeyClient, modelClient);
  const project = queryContext.split("\n")[0]?.replace("Project: ", "") ?? "unknown";
  const memories = await retriever.retrieve(queryContext, project);

  if (memories.length > 0) {
    const formatted = formatForInjection(memories);
    // Write context file for reference
    await Bun.write(config.memory.contextFile, formatted);
    // Output to stdout — Claude Code injects this into context
    process.stdout.write(formatted);
  }

  await valkeyClient.quit();
});
