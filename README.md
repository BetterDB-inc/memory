# BetterDB Memory for Claude Code

Persistent, semantic memory for Claude Code sessions — powered by Valkey.

Every time you start a new Claude Code session, context is lost. BetterDB Memory
automatically captures what you did, embeds it as vectors in Valkey, and retrieves
relevant history at the start of each new session.

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) runtime — **required** (the CLI and all hooks run on Bun, not Node)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [Valkey](https://valkey.io) 8.0+ with the Search module

### Install

```bash
bunx @betterdb/memory install
```

This will:
1. Compile native hook binaries to `~/.betterdb/bin/`
2. Register 4 lifecycle hooks with Claude Code
3. Register the MCP server for mid-conversation tools
4. Create the Valkey search index

### How It Works

| Hook | What it does |
|------|-------------|
| **SessionStart** | Retrieves relevant memories via vector search, injects as context |
| **PostToolUse** | Records every tool call to a temp JSONL file |
| **Stop** | Summarizes the session, embeds it, stores in Valkey |
| **PreToolUse** | Surfaces file-specific history when accessing known files |

### MCP Tools

Claude can use these mid-conversation:
- `search_context` — Semantic search over past sessions
- `store_insight` — Save a decision, pattern, or warning
- `list_open_threads` — Show unresolved items
- `forget` — Delete a specific memory

### CLI Commands

```bash
bunx @betterdb/memory install    # Set up hooks + MCP server
bunx @betterdb/memory status     # Check health
bunx @betterdb/memory uninstall  # Remove everything
bunx @betterdb/memory maintain   # Run aging/compression manually
```

### Configuration

Via environment variables or `~/.betterdb/memory.json`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_VALKEY_URL` | `redis://localhost:6379` | Valkey connection URL |
| `BETTERDB_EMBED_MODEL` | auto-detect | Embedding provider |
| `BETTERDB_SUMMARIZE_MODEL` | auto-detect | Summarization provider |
| `BETTERDB_EMBED_DIM` | `1024` | Embedding dimensions |
| `BETTERDB_MAX_CONTEXT_MEMORIES` | `5` | Memories injected per session |
| `BETTERDB_CONTEXT_FILE` | `.betterdb_context.md` | Context injection file |

## License

MIT
