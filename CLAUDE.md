# BetterDB Memory for Claude Code — Developer Guide

## Memory & Recall

This project has a persistent memory system (BetterDB). When a user asks about previous sessions, past commands, earlier decisions, or anything from prior conversations, **always use the `search_context` MCP tool first** before answering. Do not guess or rely only on CLAUDE.md — search your actual memories.

Available MCP tools:
- `search_context` — Search past sessions for relevant context. Use this for any "what did I/we do" questions.
- `store_insight` — Save an important decision, pattern, or warning explicitly.
- `list_open_threads` — Show unresolved items from past sessions.
- `forget` — Delete a specific memory.

## Setup

```bash
docker compose up -d        # Start Valkey (with search module) + Ollama
bun install                 # Install dependencies
bun run setup-index         # Create the FT index
```

Ollama models are pulled automatically by the `ollama-init` container. If running Ollama locally, pull manually:
```bash
ollama pull mxbai-embed-large
ollama pull mistral:7b
```

## Development

- **Runtime:** Bun only. No Node.js, tsx, or ts-node.
- **Unit tests:** `bun test tests/unit` — no external deps required.
- **Integration tests:** `bun test tests/integration` — requires Docker (Valkey) running. Set `BETTERDB_SKIP_INTEGRATION=true` to skip.
- **Type checking:** `bun run typecheck` — must pass with zero errors.

## Build

```bash
bun run build:hooks         # Compile hook binaries → dist/hooks/
```

Hook binaries are platform-specific (`bun build --compile`). Always rebuild before running `install-hooks.sh`. Cross-compile with `--target` if deploying to a different OS/arch.

## Hooks

- All hooks use the `runHook()` wrapper from `src/hooks/_utils.ts`.
- Hooks must **never** throw unhandled exceptions — errors go to stderr, exit code is always 0.
- Hook events: `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`.
- Hooks receive JSON on stdin per the Claude Code hooks contract.
- If Ollama is unavailable at session end, raw transcripts are queued to `betterdb:ingest_queue` — never dropped.

## Changing Embed Models

Changing `BETTERDB_EMBED_MODEL` or `BETTERDB_EMBED_DIM` requires re-embedding all stored memories:

```bash
bun run migrate-embeddings -- --dry-run   # Preview
bun run migrate-embeddings                # Execute
```

The system refuses to start if `BETTERDB_EMBED_DIM` doesn't match the stored dimension.

## License Policy

- Default models must be MIT or Apache 2.0 (currently: `mxbai-embed-large`, `mistral:7b`).
- Attribution-required models (CC BY, Qwen License) go in `PRESET_ATTRIBUTION` only.
- Verify license before adding any new default model.

## Key Conventions

- **No secrets in code.** All connection strings and API keys via `.env` only. `.env` is gitignored.
- **Valkey key prefix:** All keys use `betterdb:` prefix. Never write bare keys.
- **Single responsibility per file.** Client code knows nothing about hooks. Hooks import from client and memory modules only.
- **No `any`.** TypeScript strict mode. Use `.parse()` or `.safeParse()` for all Zod results.
- **Compression is bounded.** Max 50 memories from compress queue, max 100 per project group per run.
- **`.betterdb_context.md` is transient.** Gitignored. Cleaned up on session end.
- **Bun APIs preferred.** Use `Bun.file()`, `Bun.write()`, `Bun.spawnSync()` over Node equivalents.
- **Valkey Search module:** `valkey/valkey-bundle:8` ships with valkey-search pre-loaded — no custom Dockerfile needed. Verify with `valkey-cli MODULE LIST` (should show `search`).
