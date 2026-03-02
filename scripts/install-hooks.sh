#!/usr/bin/env bash
set -euo pipefail

# BetterDB Memory for Claude Code — Hook & MCP Installer
# Compiles hook binaries and registers them with Claude Code

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Check prerequisites
if ! command -v claude &>/dev/null; then
  echo "ERROR: 'claude' CLI not found on PATH."
  echo "Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

if ! command -v bun &>/dev/null; then
  echo "ERROR: 'bun' not found on PATH."
  echo "Install Bun: https://bun.sh"
  exit 1
fi

# Detect platform
PLATFORM="$(uname -s)-$(uname -m)"
echo "Platform: $PLATFORM"
echo "Note: Hook binaries are platform-specific. Rebuild if deploying elsewhere."
echo ""

# Build hooks
echo "Building hook binaries..."
cd "$PROJECT_DIR"
bun run build:hooks
echo "Hook binaries compiled to dist/hooks/"
echo ""

# Write hooks to global settings
GLOBAL_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"

# Create file with empty object if it doesn't exist
if [ ! -f "$GLOBAL_SETTINGS" ]; then
  echo '{}' > "$GLOBAL_SETTINGS"
fi

# Merge hooks into existing settings using Bun (preserves other fields, overwrites hooks block)
# Each hook command sources the .env file first so compiled binaries get the right env vars
# (bun build --compile binaries don't auto-load .env like `bun run` does)
DIST_DIR="$PROJECT_DIR/dist/hooks"
ENV_FILE="$PROJECT_DIR/.env"

bun -e "
const fs = require('fs');
const settingsPath = '$GLOBAL_SETTINGS';
const envFile = '$ENV_FILE';
const distDir = '$DIST_DIR';
const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Wrap each binary so it loads .env at runtime
const wrap = (bin) =>
  'bash -c ' + JSON.stringify('set -a; [ -f ' + envFile + ' ] && . ' + envFile + '; set +a; ' + distDir + '/' + bin);

const hooks = {
  SessionStart: [{ hooks: [{ type: 'command', command: wrap('session-start') }] }],
  PreToolUse:   [{ matcher: '', hooks: [{ type: 'command', command: wrap('pre-tool') }] }],
  PostToolUse:  [{ matcher: '', hooks: [{ type: 'command', command: wrap('post-tool') }] }],
  Stop:         [{ hooks: [{ type: 'command', command: wrap('session-end') }] }],
};
fs.writeFileSync(settingsPath, JSON.stringify({ ...existing, hooks }, null, 2));
console.log('Hook configuration written to: ' + settingsPath);
"

# Register MCP server
echo ""
echo "Registering MCP server..."
claude mcp add-json betterdb-memory "{\"type\":\"stdio\",\"command\":\"bun\",\"args\":[\"run\",\"$PROJECT_DIR/src/mcp/server.ts\"]}" 2>/dev/null || true
echo "MCP server registered: betterdb-memory"

# Verify hooks
echo ""
echo "Verifying global settings..."
bun -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$HOME/.claude/settings.json', 'utf8'));
const hookCount = Object.keys(settings.hooks || {}).length;
console.log('Hooks registered: ' + hookCount + ' lifecycle events');
"

# Summary
echo ""
echo "=== Installation Complete ==="
echo ""
echo "Hooks written to: ~/.claude/settings.json"
echo "  SessionStart  → $DIST_DIR/session-start"
echo "  Stop          → $DIST_DIR/session-end"
echo "  PreToolUse    → $DIST_DIR/pre-tool"
echo "  PostToolUse   → $DIST_DIR/post-tool"
echo ""
echo "MCP server: betterdb-memory (stdio)"
echo ""
echo "Next steps:"
echo "  1. Start infrastructure: docker compose up -d"
echo "  2. Create search index: bun run setup-index"
echo "  3. Start a new Claude Code session — memories will be captured automatically"
