---
name: setup
description: Configure BetterDB Memory — connect to Valkey and create the search index
---

# BetterDB Memory Setup

Run the initial setup for BetterDB Memory. This configures the Valkey connection and creates the vector search index.

## Steps

1. Check if Bun is installed. If not, tell the user to install it from https://bun.sh
2. Check if a config file exists at `~/.betterdb/memory.json`. If it does, ask the user if they want to reconfigure.
3. Ask the user for their Valkey connection URL (default: `redis://localhost:6379`).
4. **Save the config to `~/.betterdb/memory.json` immediately** with the user-provided Valkey URL (as `BETTERDB_VALKEY_URL`). This must happen before running setup-index so the script picks up the correct connection URL.
5. **Test the connection** — try to connect to Valkey at the saved URL and run `valkey-cli -u <url> PING` (or equivalent).
6. If reachable: run `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/setup-index.ts` to create the FT.SEARCH index. Continue to step 8.
7. If NOT reachable: ask the user which option they prefer:
   - **Option A: "I'll set up Valkey myself"** — Print the requirements (Valkey 8.0+ with the Search module enabled). Delete `~/.betterdb/memory.json` so `isConfigured()` returns false. Tell the user to re-run `/betterdb-memory:setup` once Valkey is available. **Stop here.**
   - **Option B: "Spin up a Valkey container with Docker"** — First check if `docker` is on PATH. If Docker is not installed, tell the user to install it from https://docs.docker.com/get-docker/ and fall back to Option A. If Docker is available, find the plugin root and run:
     ```bash
     bash <plugin-root>/scripts/docker-valkey.sh
     ```
     Parse the script output for the connection URL (`redis://localhost:<port>`). If the port differs from what was saved (e.g. fallback to 16379), update `BETTERDB_VALKEY_URL` in `~/.betterdb/memory.json`. Also save `"docker": true` in `~/.betterdb/memory.json` so the status command can check container health. After Docker setup succeeds, run `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/setup-index.ts` to create the FT.SEARCH index, then continue to step 8.
8. **Register lifecycle hooks.** First, find the plugin cache directory by running:
   ```bash
   find ~/.claude/plugins/cache -name "plugin.json" -path "*betterdb-memory*" -exec dirname {} \; 2>/dev/null | head -1 | sed 's|/.claude-plugin||'
   ```
   Use the output as the plugin root path. Then run:
   ```bash
   bun run <plugin-root>/scripts/register-hooks.ts <plugin-root>
   ```
   Replace `<plugin-root>` with the actual absolute path found above. This writes hooks with absolute paths into `~/.claude/settings.json`.
9. Tell the user: **"Restart Claude Code for hooks to take effect."** Setup is complete.
