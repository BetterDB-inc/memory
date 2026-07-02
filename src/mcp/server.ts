import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getValkeyClient } from "../client/valkey.js";
import { getPluginMemoryStore } from "../client/memory-store.js";
import { createModelClient } from "../client/model.js";
import { formatSearchResult } from "../memory/retrieval.js";
import { escalatingRecall } from "../memory/recall.js";
import { getCwdProject, getGitBranch } from "../memory/capture.js";
import { isConfigured } from "../config.js";
import type { EpisodicMemory, KnowledgeEntry } from "../memory/schema.js";

const SETUP_MESSAGE =
  "BetterDB Memory is not configured yet. Run /betterdb-memory:setup to connect to Valkey and create the search index.";

const server = new McpServer({
  name: "betterdb-memory",
  version: "0.4.0",
});

// --- Tool: search_context ---

server.tool(
  "search_context",
  "Search your past Claude Code sessions for relevant context, decisions, or patterns. " +
    "Escalates automatically (project → wider → cross-project) and gates by relevance, " +
    "so a miss means nothing relevant is stored — never fabricate to fill a miss.",
  {
    query: z.string().describe("The search query"),
    top_k: z.number().int().min(1).max(20).optional().describe("Max results shown (default: 5)"),
    scope: z
      .enum(["project", "all"])
      .optional()
      .describe(
        "Search scope. 'project' (default) stays in the current project; " +
          "'all' also searches across every project — use when a project-scoped search found nothing.",
      ),
    tags: z
      .array(z.enum(["decision", "pattern", "problem", "open-thread"]))
      .optional()
      .describe(
        "Filter to memories of these content types — e.g. ['decision'] to " +
          "recall only decisions, ['open-thread'] for unresolved items.",
      ),
  },
  async ({ query, top_k, scope, tags }) => {
    if (!isConfigured()) {
      return { content: [{ type: "text" as const, text: SETUP_MESSAGE }] };
    }

    const modelClient = await createModelClient();
    const store = await getPluginMemoryStore((t) => modelClient.embed(t));

    const project = getCwdProject();
    const branch = getGitBranch();
    const k = top_k ?? 5;
    // Default (project) scope stays in-project so a miss can *offer* to widen
    // to all projects — the two-step consent flow. An explicit scope="all"
    // requests the cross-project rung; escalatingRecall still gates it on
    // BETTERDB_ALLOW_CROSS_PROJECT and flags the miss honestly if it's off.
    const result = await escalatingRecall(store, query, {
      project,
      ...(branch !== "unknown" ? { branch } : {}),
      ...(tags !== undefined ? { tags } : {}),
      crossProjectRequested: scope === "all",
    });
    const formatted = formatSearchResult(query, result, k);

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
);

// --- Tool: store_insight ---

server.tool(
  "store_insight",
  "Explicitly save an important insight, decision, or warning to persistent memory",
  {
    content: z.string().describe("The insight content"),
    category: z
      .enum(["decision", "pattern", "warning"])
      .describe("Category of the insight"),
    project: z.string().optional().describe("Project name (auto-detected if omitted)"),
  },
  async ({ content, category, project: projectInput }) => {
    if (!isConfigured()) {
      return { content: [{ type: "text" as const, text: SETUP_MESSAGE }] };
    }

    const valkeyClient = await getValkeyClient();
    const modelClient = await createModelClient();
    const store = await getPluginMemoryStore((t) => modelClient.embed(t));
    const project = projectInput ?? getCwdProject();

    // Store as EpisodicMemory for vector searchability. MemoryStore mints the
    // id, so capture it for the knowledge link and the user-facing response.
    const memory: EpisodicMemory = {
      memoryId: crypto.randomUUID(),
      project,
      branch: "manual",
      timestamp: new Date().toISOString(),
      summary: {
        decisions: category === "decision" ? [content] : [],
        patterns: category === "pattern" ? [content] : [],
        problemsSolved: [],
        openThreads: category === "warning" ? [content] : [],
        filesChanged: [],
        oneLineSummary: `[${category}] ${content}`,
      },
      importanceScore: 0.8,
      accessCount: 0,
      lastAccessed: new Date().toISOString(),
    };
    const memoryId = await store.storeMemory(memory);

    // Store as KnowledgeEntry, linked to the episodic memory just written.
    const entry: KnowledgeEntry = {
      entryId: crypto.randomUUID(),
      project,
      topic: category,
      fact: content,
      confidence: 0.9,
      sourceMemoryIds: [memoryId],
      lastUpdated: new Date().toISOString(),
      accessCount: 0,
    };
    await valkeyClient.storeKnowledge(entry);

    return {
      content: [
        {
          type: "text" as const,
          text: `Stored ${category}: "${content}" (memory: ${memoryId})`,
        },
      ],
    };
  },
);

// --- Tool: list_open_threads ---

server.tool(
  "list_open_threads",
  "List unresolved questions and TODO items from past sessions",
  {
    project: z.string().optional().describe("Project name (auto-detected if omitted)"),
  },
  async ({ project: projectInput }) => {
    if (!isConfigured()) {
      return { content: [{ type: "text" as const, text: SETUP_MESSAGE }] };
    }

    const store = await getPluginMemoryStore();
    const project = projectInput ?? getCwdProject();

    const memories = await store.listMemories(project, 0.5);
    const threads = new Set<string>();

    for (const memory of memories) {
      for (const thread of memory.summary.openThreads) {
        threads.add(thread);
      }
    }

    if (threads.size === 0) {
      return {
        content: [
          { type: "text" as const, text: "No open threads found." },
        ],
      };
    }

    const formatted = `# Open Threads for ${project}\n\n${[...threads].map((t) => `- [ ] ${t}`).join("\n")}`;

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
);

// --- Tool: forget ---

server.tool(
  "forget",
  "Permanently delete a specific memory entry",
  {
    memory_id: z.string().describe("The memory ID to delete"),
    confirmed: z.boolean().optional().describe("Set to true to confirm deletion"),
  },
  async ({ memory_id, confirmed }) => {
    if (!isConfigured()) {
      return { content: [{ type: "text" as const, text: SETUP_MESSAGE }] };
    }

    const store = await getPluginMemoryStore();

    if (!confirmed) {
      const memory = await store.getMemory(memory_id);
      if (!memory) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Memory ${memory_id} not found.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Are you sure you want to delete this memory?\n\n` +
              `**Summary:** ${memory.summary.oneLineSummary}\n` +
              `**Project:** ${memory.project}\n` +
              `**Date:** ${memory.timestamp.split("T")[0]}\n\n` +
              `Call forget again with confirmed=true to proceed.`,
          },
        ],
      };
    }

    await store.deleteMemory(memory_id);

    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${memory_id} has been permanently deleted.`,
        },
      ],
    };
  },
);

// --- Start Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
