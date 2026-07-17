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

# Merge hooks into existing settings using Bun — replaces our own entries per
# event and preserves every other field, including third-party hooks
# Each hook command sources the .env file first so compiled binaries get the right env vars
# (bun build --compile binaries don't auto-load .env like `bun run` does)
DIST_DIR="$PROJECT_DIR/dist/hooks"
ENV_FILE="$PROJECT_DIR/.env"

bun -e "
const fs = require('fs');
const { buildHookMap, isOwnHookEntry } = require('$PROJECT_DIR/src/hook-spec.ts');
const settingsPath = '$GLOBAL_SETTINGS';
const envFile = '$ENV_FILE';
const distDir = '$DIST_DIR';
const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Wrap each binary so it loads .env at runtime
const wrap = (bin) =>
  'bash -c ' + JSON.stringify('set -a; [ -f ' + envFile + ' ] && . ' + envFile + '; set +a; ' + distDir + '/' + bin);

const hooks = { ...(existing.hooks || {}) };
for (const [event, entries] of Object.entries(buildHookMap((spec) => wrap(spec.binary)))) {
  const prev = Array.isArray(hooks[event]) ? hooks[event] : [];
  const kept = prev.filter((entry) => !isOwnHookEntry(entry, [distDir, 'betterdb']));
  hooks[event] = [...kept, ...entries];
}
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
const { HOOK_SPECS } = require('$PROJECT_DIR/src/hook-spec.ts');
const settings = JSON.parse(fs.readFileSync('$HOME/.claude/settings.json', 'utf8'));
const missing = HOOK_SPECS.filter((spec) => {
  const entries = (settings.hooks || {})[spec.event] || [];
  return !JSON.stringify(entries).includes(spec.binary);
});
console.log('Hooks registered: ' + (HOOK_SPECS.length - missing.length) + '/' + HOOK_SPECS.length + ' lifecycle events');
if (missing.length > 0) {
  console.error('ERROR: not registered: ' + missing.map((spec) => spec.event).join(', '));
  process.exit(1);
}
"

# Summary
echo ""
echo "=== Installation Complete ==="
echo ""
echo "Hooks written to: ~/.claude/settings.json"
bun -e "
const { formatHookSummary } = require('$PROJECT_DIR/src/hook-spec.ts');
const distDir = '$DIST_DIR';
for (const line of formatHookSummary((spec) => distDir + '/' + spec.binary)) {
  console.log(line);
}
"
echo ""
echo "MCP server: betterdb-memory (stdio)"
echo ""
echo "Next steps:"
echo "  1. Start infrastructure: docker compose up -d"
echo "  2. Create search index: bun run setup-index"
echo "  3. Start a new Claude Code session — memories will be captured automatically"
