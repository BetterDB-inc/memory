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
# 1. Copy .env.example and fill in your settings
cp .env.example .env

# 2. Install
bunx @betterdb/memory install
```

The install will:
1. Compile native hook binaries to `~/.betterdb/bin/`
2. Register 4 lifecycle hooks with Claude Code
3. Register the MCP server for mid-conversation tools
4. Create the Valkey search index
5. Save your `.env` values to `~/.betterdb/memory.json` for runtime use

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

Copy `.env.example` to `.env` and fill in your values before running `bunx @betterdb/memory install`. They get saved to `~/.betterdb/memory.json` and used by the compiled binaries at runtime.

#### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_VALKEY_URL` | `redis://localhost:6379` | Valkey connection URL |
| `BETTERDB_VALKEY_INDEX_NAME` | `betterdb-memory-index` | Valkey search index name |
| `BETTERDB_EMBED_DIM` | `1024` | Embedding dimensions |
| `BETTERDB_MAX_CONTEXT_MEMORIES` | `5` | Max memories injected per session (after gating) |
| `BETTERDB_CONTEXT_FILE` | `.betterdb_context.md` | Context injection file |
| `BETTERDB_ALLOW_REMOTE_FALLBACK` | `true` | Fall back to remote APIs if local models unavailable |

#### Recall Gating

Recall over-fetches a candidate pool, gates it by relevance, and escalates on a
miss (project → wider pool → cross-project). `search_context` returns nothing
only when nothing clears the bar — so a miss is honest, not a silent drop.

The gate is **relative**, not an absolute similarity threshold: embed models
compress cosine similarity into different, narrow bands (mxbai-embed-large packs
everything into ~0.7–0.88), so a fixed threshold doesn't transfer across models.
Instead, `floor` drops genuine noise, and hits within `margin` of the top match
are kept; confidence comes from the scale-independent top-vs-next gap.

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_RECALL_FLOOR` | `0.5` | Similarity floor — drops noise and loosens the store's own distance gate |
| `BETTERDB_RECALL_MARGIN` | `0.05` | Keep hits within this similarity of the top match |
| `BETTERDB_RECALL_SEPARATION` | `0.04` | Top-vs-next gap above which a match is "high" confidence |
| `BETTERDB_RECALL_POOL_K` | `10` | Rung-1 over-fetch pool (project) |
| `BETTERDB_RECALL_POOL_K_WIDE` | `20` | Rung-2/3 over-fetch pool (wider / cross-project) |
| `BETTERDB_ALLOW_CROSS_PROJECT` | `true` | Allow escalation / `scope="all"` to search across projects |

#### Model Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTERDB_EMBED_PROVIDER` | auto-detect | Force embed provider: `local`, `ollama`, `voyage`, `openai`, `groq`, `together` |
| `BETTERDB_SUMMARIZE_PROVIDER` | auto-detect | Force summarize provider: `ollama`, `anthropic`, `openai`, `groq`, `together` |
| `BETTERDB_EMBED_MODEL` | `mxbai-embed-large` | Ollama embedding model name |
| `BETTERDB_SUMMARIZE_MODEL` | `mistral:7b` | Ollama summarization model name |
| `BETTERDB_OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |

#### Embeddings work with zero config

If no embedding provider is detected (no Ollama models, no API keys), BetterDB falls back to **on-device embeddings** via `@xenova/transformers` (`all-MiniLM-L6-v2`, 384-dim, Apache-2.0). No API key, no running service — the model weights download once on first use and are cached thereafter. Auto-detected providers (Ollama, then API keys) take priority when available.

#### API Keys

Embeddings always work (on-device fallback above). A summarization provider is still required — Ollama is free and local; the others require API keys.

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
