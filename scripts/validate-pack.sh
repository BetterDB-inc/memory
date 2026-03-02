#!/bin/bash
set -euo pipefail

echo "=== Validating @betterdb/memory package ==="
FAIL=0

# Package name
NAME=$(node -e "console.log(require('./package.json').name)")
[ "$NAME" = "@betterdb/memory" ] && echo "✅ Name: $NAME" || { echo "❌ Name: $NAME (expected @betterdb/memory)"; FAIL=1; }

# files field
node -e "const p=require('./package.json'); if(!p.files) process.exit(1)" 2>/dev/null \
  && echo "✅ Has files field" || { echo "❌ Missing files field"; FAIL=1; }

# src/ in files
node -e "const p=require('./package.json'); if(!p.files.includes('src/')) process.exit(1)" 2>/dev/null \
  && echo "✅ src/ in files" || { echo "❌ src/ not in files"; FAIL=1; }

# dist/ NOT in files
node -e "const p=require('./package.json'); if(p.files && p.files.includes('dist/')) process.exit(1)" 2>/dev/null \
  || { echo "❌ dist/ in files — remove it"; FAIL=1; }
echo "✅ dist/ not in files"

# bin entry
node -e "const p=require('./package.json'); if(!p.bin?.['betterdb-memory']) process.exit(1)" 2>/dev/null \
  && echo "✅ bin: betterdb-memory" || { echo "❌ Missing bin entry"; FAIL=1; }

# bin target exists
BIN=$(node -e "console.log(require('./package.json').bin['betterdb-memory'])")
[ -f "$BIN" ] && echo "✅ bin target exists: $BIN" || { echo "❌ bin target missing: $BIN"; FAIL=1; }

# No monorepo artifacts
[ ! -f pnpm-workspace.yaml ] && echo "✅ No pnpm-workspace.yaml" || { echo "❌ pnpm-workspace.yaml exists"; FAIL=1; }
[ ! -f turbo.json ] && echo "✅ No turbo.json" || { echo "❌ turbo.json exists"; FAIL=1; }
[ ! -d packages ] && echo "✅ No packages/" || { echo "❌ packages/ directory exists"; FAIL=1; }

# No Docker artifacts to ship
PACK=$(npm pack --dry-run 2>&1)
echo "$PACK" | grep -q "Dockerfile" && { echo "❌ Dockerfile in package"; FAIL=1; } || echo "✅ No Dockerfile in package"

# Leaks
for leak in "node_modules" ".env" ".git/"; do
  echo "$PACK" | grep -q "$leak" && { echo "❌ $leak leaking"; FAIL=1; }
done
echo "✅ No leaks"

# Standalone install
echo ""
echo "--- Standalone install ---"
TMPDIR=$(mktemp -d)
TARBALL=$(npm pack 2>/dev/null)
(
  cd "$TMPDIR"
  npm init -y > /dev/null 2>&1
  if npm install "$OLDPWD/$TARBALL" > /dev/null 2>&1; then
    echo "✅ Installs standalone"
    [ -d "node_modules/@betterdb/memory/src" ] && echo "✅ src/ present" || { echo "❌ src/ missing"; FAIL=1; }
    [ -f node_modules/.bin/betterdb-memory ] && echo "✅ bin linked" || echo "⚠️  bin not linked"
  else
    echo "❌ Install failed"; FAIL=1
  fi
)
rm -rf "$TMPDIR"
rm -f "$TARBALL"

echo ""
[ $FAIL -eq 0 ] && echo "=== ✅ All checks passed ===" || { echo "=== ❌ FAILED ==="; exit 1; }
