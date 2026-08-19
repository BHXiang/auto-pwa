#!/bin/bash
# setup-dev.sh — link a DeepSeek Harness checkout's packages into node_modules
# so contributors can develop/test against the REAL dsh-tools/cordis API
# (types + runtime), instead of the vendored stubs in vendor/dsh/.
#
# Usage:
#   DSH_ROOT=/path/to/deepseek-harness npm run dev:setup
#   # or rely on the default path below
#
# After linking, tsconfig `paths` still points at vendor/dsh for typecheck;
# for the real types either remove the paths entries or run:
#   tsc --noEmit --paths @deepseek-ai/dsh-tools=node_modules/@deepseek-ai/dsh-tools
# The plugin at DSH load time ALWAYS resolves the runtime provided by DSH.
set -eu

DSH_ROOT="${DSH_ROOT:-/home/whitewash/pkgs/deepseek-harness}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HERE/node_modules/@deepseek-ai"
mkdir -p "$TARGET"

if [ ! -d "$DSH_ROOT/packages/core/tools" ]; then
  echo "✗ DSH checkout not found at $DSH_ROOT (set DSH_ROOT)"
  exit 1
fi

# package name -> relative path inside the checkout
LINKS="
dsh-tools:packages/core/tools
cordis:vendor/cordis
schemastery:vendor/schemastery
dsh-agent:packages/core/agent
dsh-code-runtime:packages/code-runtime/code-runtime
dsh-invariants:packages/runtime-diagnostics/invariants
dsh-llm:packages/llm/llm
dsh-scope:packages/core/scope
dsh-session:packages/core/session
dsh-system-prompt:packages/core/system-prompt
dsh-user-approval:packages/interaction/user-approval
"

for entry in $LINKS; do
  name="${entry%%:*}"
  rel="${entry#*:}"
  src="$DSH_ROOT/$rel"
  if [ -e "$src/package.json" ]; then
    ln -sfn "$src" "$TARGET/$name"
    echo "  linked @deepseek-ai/$name -> $rel"
  else
    echo "  ✗ missing $rel (skipped)"
  fi
done

echo "done. Run: npm install && npm test"
