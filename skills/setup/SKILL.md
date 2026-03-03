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
6. If reachable: run `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/setup-index.ts` to create the FT.SEARCH index, then confirm setup is complete.
7. If NOT reachable: delete `~/.betterdb/memory.json` (so `isConfigured()` returns false), explain that BetterDB Memory requires Valkey 8.0+ with the Search module, and suggest the user fix the connection and re-run `/betterdb-memory:setup`:
   - `docker run -d --name valkey -p 6379:6379 valkey/valkey:8-alpine`
   - Or use their existing Valkey/Redis instance with the Search module enabled.
