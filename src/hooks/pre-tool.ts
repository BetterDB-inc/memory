import { readRawPayload, runHook } from "./_utils.js";
import { getPluginMemoryStore } from "../client/memory-store.js";
import { config, isConfigured } from "../config.js";

/**
 * PreToolUse hook: Checks for file history and appends notes to context.
 *
 * Claude Code hooks contract:
 * - Fires before a tool call executes
 * - Receives JSON on stdin with tool_name, tool_input
 * - Exit 0 to allow, exit 2 to block
 */
runHook(async () => {
  if (!isConfigured()) return;
  const payload = await readRawPayload();
  const toolInput = payload["tool_input"] as Record<string, unknown> | undefined;

  // Extract file path from tool input
  const filePath =
    (toolInput?.["file_path"] as string) ??
    (toolInput?.["path"] as string) ??
    null;

  if (!filePath) return;

  let store;
  try {
    store = await getPluginMemoryStore();
  } catch {
    return; // Valkey unavailable — skip silently
  }

  // Scan for memories that reference this file
  const memories = await store.listMemories();
  const relevantNotes: string[] = [];

  for (const memory of memories.slice(0, 50)) {
    if (memory.summary.filesChanged.some((f) => f.includes(filePath) || filePath.includes(f))) {
      relevantNotes.push(
        `- ${memory.summary.oneLineSummary} (${memory.timestamp.split("T")[0]})`,
      );
    }
  }

  if (relevantNotes.length > 0) {
    const contextFile = Bun.file(config.memory.contextFile);
    let existing = "";
    if (await contextFile.exists()) {
      existing = await contextFile.text();
    }

    const note = `\n\n## File History: ${filePath}\n${relevantNotes.slice(0, 3).join("\n")}`;
    await Bun.write(config.memory.contextFile, existing + note);
  }

  await store.close();
});
