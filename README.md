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

#### As a Claude Code Plugin (recommended)

```
/plugin marketplace add BetterDB-inc/memory
/plugin install betterdb-memory
```

Then run `/betterdb-memory:setup` to configure your Valkey connection and create the search index.

#### Via CLI

```bash
bunx @betterdb/memory install
```

The CLI install will:
1. Compile native hook binaries to `~/.betterdb/bin/`
2. Register 4 lifecycle hooks with Claude Code
3. Register the MCP server for mid-conversation tools
4. Create the Valkey search index

### Don't have Valkey?

The setup skill will offer to spin one up in Docker for you. Or run it manually:

```bash
# Via CLI
bunx @betterdb/memory docker-valkey

# Or directly with Docker
docker run -d --name betterdb-valkey -p 6379:6379 -v betterdb-valkey-data:/data valkey/valkey-search:8 valkey-server --save 60 1
```

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
bunx @betterdb/memory install        # Set up hooks + MCP server
bunx @betterdb/memory status         # Check health
bunx @betterdb/memory uninstall      # Remove everything
bunx @betterdb/memory maintain       # Run aging/compression manually
bunx @betterdb/memory docker-valkey  # Manage Docker Valkey container
```

### Configuration

Set env vars before running `bunx @betterdb/memory install` — they get saved to `~/.betterdb/memory.json` and used by the compiled binaries at runtime.

#### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_VALKEY_URL` | `redis://localhost:6379` | Valkey connection URL |
| `BETTERDB_VALKEY_INDEX_NAME` | `betterdb-memory-index` | Valkey search index name |
| `BETTERDB_EMBED_DIM` | `1024` | Embedding dimensions |
| `BETTERDB_MAX_CONTEXT_MEMORIES` | `5` | Memories injected per session |
| `BETTERDB_CONTEXT_FILE` | `.betterdb_context.md` | Context injection file |
| `BETTERDB_ALLOW_REMOTE_FALLBACK` | `true` | Fall back to remote APIs if local models unavailable |

#### Model Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_EMBED_PROVIDER` | auto-detect | Force embed provider: `ollama`, `voyage`, `openai`, `groq`, `together` |
| `BETTERDB_SUMMARIZE_PROVIDER` | auto-detect | Force summarize provider: `ollama`, `anthropic`, `openai`, `groq`, `together` |
| `BETTERDB_EMBED_MODEL` | `mxbai-embed-large` | Ollama embedding model name |
| `BETTERDB_SUMMARIZE_MODEL` | `mistral:7b` | Ollama summarization model name |
| `BETTERDB_OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |

#### API Keys

At least one embedding provider and one summarization provider must be available. Ollama is free and local; the others require API keys.

| Variable | Provider | Used for |
|----------|----------|----------|
| `ANTHROPIC_API_KEY` | [Anthropic](https://console.anthropic.com/) | Summarization only (no embeddings) |
| `VOYAGE_API_KEY` | [Voyage AI](https://www.voyageai.com/) | Embeddings only |
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/) | Embeddings + summarization |
| `GROQ_API_KEY` | [Groq](https://console.groq.com/) | Embeddings + summarization |
| `TOGETHER_API_KEY` | [Together AI](https://www.together.ai/) | Embeddings + summarization |

#### Aging Pipeline

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_DECAY_RATE` | `0.95` | Memory importance decay per day |
| `BETTERDB_COMPRESS_THRESHOLD` | `0.3` | Importance threshold for compression |
| `BETTERDB_DISTILL_MIN_SESSIONS` | `5` | Min sessions before knowledge distillation |
| `BETTERDB_AGING_INTERVAL_HOURS` | `6` | Hours between automatic aging runs |

## License

MIT
