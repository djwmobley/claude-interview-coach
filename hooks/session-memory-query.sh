#!/usr/bin/env bash
# Hook: UserPromptSubmit — query semantic memory on first prompt of each session.
# Runs once per session (uses a sentinel file keyed by SESSION_ID).
# Injects matching coached answers and session moments as context.

set -euo pipefail

SESSION_ID="${CLAUDE_SESSION_ID:-default}"
SENTINEL="/tmp/ic_memory_queried_${SESSION_ID}"

# Only run on the first prompt of the session
if [ -f "$SENTINEL" ]; then
  exit 0
fi

# Read the user's prompt from stdin (hook receives JSON on stdin)
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # UserPromptSubmit sends the prompt content
    content = data.get('content', '') if isinstance(data, dict) else str(data)
    # Truncate to first 200 chars for a reasonable query
    print(content[:200])
except:
    print('')
" 2>/dev/null)

if [ -z "$PROMPT" ]; then
  # No prompt text available, skip
  touch "$SENTINEL"
  exit 0
fi

# Change to project directory
cd "C:/claude-interview-coach/claude-interview-coach"

# Run the memory query
RESULT=$(python tools/query_memory.py "$PROMPT" --top 5 2>/dev/null) || true

# Create sentinel so this doesn't run again this session
touch "$SENTINEL"

if [ -n "$RESULT" ]; then
  echo "=== Semantic Memory Context (auto-queried from first prompt) ==="
  echo "$RESULT"
  echo "=== End Memory Context ==="
else
  echo "(No relevant semantic memory found for this session topic.)"
fi
