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
4. Run `bun run ${CLAUDE_PLUGIN_ROOT}/scripts/setup-index.ts` to create the FT.SEARCH index.
5. Save the config to `~/.betterdb/memory.json`.
6. Confirm setup is complete.

If Valkey is not reachable, explain that BetterDB Memory requires Valkey 8.0+ with the Search module. Suggest:
- `docker run -d --name valkey -p 6379:6379 valkey/valkey:8-alpine`
- Or use their existing Valkey/Redis instance with the Search module enabled.
