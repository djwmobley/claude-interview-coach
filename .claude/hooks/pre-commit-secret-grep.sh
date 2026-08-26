#!/usr/bin/env bash
# PreToolUse hook (Bash and PowerShell tools): when the command about to run is
# a `git commit`, grep the STAGED files for connection strings and DSN
# assignments. Blocks the commit (exit 2) on any hit outside .env.example.
#
# Registered in .claude/settings.json. Reads the tool input JSON on stdin.
# Patterns: postgres:// or postgresql:// anywhere, and PG_DSN= assignments.

set -u
input="$(cat)"

# Only act on git commit commands. Cheap string test on the JSON; no JSON parser needed.
if ! printf '%s' "$input" | grep -Eq 'git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit'; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$repo_root" || exit 0

hits=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$(basename "$f")" in
    .env.example) continue ;;
  esac
  case "$f" in
    .claude/hooks/pre-commit-secret-grep.sh) continue ;;
  esac
  if git show ":$f" 2>/dev/null | grep -Enq 'postgres(ql)?://|PG_DSN='; then
    lines="$(git show ":$f" | grep -En 'postgres(ql)?://|PG_DSN=' | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
    hits="${hits}  ${f} (lines ${lines})"$'\n'
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [ -n "$hits" ]; then
  {
    echo "BLOCKED: staged files contain a Postgres connection string or PG_DSN= assignment."
    echo "Move secrets to mcp/job-search/.env (gitignored); only .env.example may hold placeholders."
    printf '%s' "$hits"
  } >&2
  exit 2
fi
exit 0
