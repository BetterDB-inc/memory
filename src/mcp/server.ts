import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getValkeyClient } from "../client/valkey.js";
import { createModelClient } from "../client/model.js";
import { formatForInjection } from "../memory/retrieval.js";
import { getCwdProject } from "../memory/capture.js";
import type { EpisodicMemory, KnowledgeEntry } from "../memory/schema.js";

const server = new McpServer({
  name: "betterdb-memory",
  version: "0.1.0",
});

// --- Tool: search_context ---

server.tool(
  "search_context",
  "Search your past Claude Code sessions for relevant context, decisions, or patterns",
  {
    query: z.string().describe("The search query"),
    top_k: z.number().int().min(1).max(20).optional().describe("Max results (default: 5)"),
  },
  async ({ query, top_k }) => {
    const valkeyClient = await getValkeyClient();
    const modelClient = await createModelClient();

    const embedding = await modelClient.embed(query);
    const project = getCwdProject();
    const k = top_k ?? 5;

    const memories = await valkeyClient.searchMemories(embedding, project, k);
    const formatted = formatForInjection(memories);

    return {
      content: [
        {
          type: "text" as const,
          text: formatted || "No matching memories found.",
        },
      ],
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
    const valkeyClient = await getValkeyClient();
    const modelClient = await createModelClient();
    const project = projectInput ?? getCwdProject();

    // Store as KnowledgeEntry
    const entry: KnowledgeEntry = {
      entryId: crypto.randomUUID(),
      project,
      topic: category,
      fact: content,
      confidence: 0.9,
      sourceMemoryIds: [],
      lastUpdated: new Date().toISOString(),
      accessCount: 0,
    };
    await valkeyClient.storeKnowledge(entry);

    // Also store as EpisodicMemory for vector searchability
    const embedding = await modelClient.embed(content);
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
    await valkeyClient.storeMemory(memory, embedding);

    return {
      content: [
        {
          type: "text" as const,
          text: `Stored ${category}: "${content}" (memory: ${memory.memoryId})`,
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
    const valkeyClient = await getValkeyClient();
    const project = projectInput ?? getCwdProject();

    const memoryIds = await valkeyClient.listMemoryIds(project, 0.5);
    const threads = new Set<string>();

    for (const id of memoryIds) {
      const memory = await valkeyClient.getMemory(id);
      if (!memory) continue;
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
    const valkeyClient = await getValkeyClient();

    if (!confirmed) {
      const memory = await valkeyClient.getMemory(memory_id);
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

    await valkeyClient.deleteMemory(memory_id);

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
