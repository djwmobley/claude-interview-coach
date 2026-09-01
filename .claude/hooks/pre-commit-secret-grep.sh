#!/usr/bin/env bash
# PreToolUse hook (Bash and PowerShell tools): when the command about to run is
# a `git commit`, scan the ADDED lines of staged files for connection strings and
# DSN assignments. Blocks the commit (exit 2) on any hit outside .env.example.
#
# Registered in .claude/settings.json. Reads the tool input JSON on stdin.
# Patterns: postgres:// or postgresql:// anywhere, and PG_DSN= assignments.
#
# Scans ADDED lines only (git diff --cached -U0), not the full staged content of
# every touched file, so a file that already contains a benign, non-secret
# DSN-shaped string (a doc-comment example, code that builds a DSN from config
# fields, a log line echoing a resolved DSN) does not block an unrelated one-line
# edit elsewhere in that same file. A brand-new file's entire content counts as
# "added", so it is still fully covered; so is a rename (git mv), because
# --no-renames makes git present it as a delete-plus-add rather than a rename
# diff, and the add side shows every line of the file as newly added.
#
# ── KNOWN LIMITATIONS (documented deliberately, not fixed by this pass) ────────
#   - PRE-EXISTING, unchanged from the original version of this hook: a commit
#     that stages content implicitly at commit time (`git commit -a`, `git
#     commit <pathspec>`, `git commit --amend` without a prior `git add`) is
#     checked by this PreToolUse hook BEFORE that implicit staging happens, so
#     new content introduced only by the implicit stage is never seen here. Out
#     of scope for this pass; unchanged behavior from before.
#   - ACCEPTED: a bulk reformat or line-ending-normalization commit re-presents
#     pre-existing, benign DSN-shaped lines as "added" (a diff sees the old and
#     new lines as a delete-plus-add pair even when the text content is
#     unchanged) and will block on them. That friction is accepted rather than
#     engineered around: it is visible (the commit fails with a clear message
#     naming the file) and correctable (re-run once the reformatted lines are
#     confirmed benign) -- the same posture this hook already takes toward any
#     other false positive.

set -u
input="$(cat)"

# Only act on git commit commands. Cheap string test on the JSON; no JSON parser needed.
if ! printf '%s' "$input" | grep -Eq 'git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit'; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$repo_root" || exit 0

PATTERN='postgres(ql)?://|PG_DSN='

# Unborn HEAD (the very first commit in a fresh repo): there is no prior commit to
# diff added lines against, and every staged byte is new anyway regardless, so fall
# back to scanning each file's full staged content instead of a line-level diff.
unborn=0
git rev-parse --verify -q HEAD >/dev/null 2>&1 || unborn=1

hits=""

while IFS= read -r -d '' f; do
  [ -z "$f" ] && continue
  case "$(basename "$f")" in
    .env.example) continue ;;
  esac
  case "$f" in
    .claude/hooks/pre-commit-secret-grep.sh) continue ;;
  esac

  if [ "$unborn" -eq 1 ]; then
    if git show ":$f" 2>/dev/null | grep -Eq "$PATTERN"; then
      hits="${hits}  ${f} (initial commit, full staged content)"$'\n'
    fi
    continue
  fi

  # Binary detection: `git diff --numstat` reports "-" instead of add/delete line
  # counts for a file it considers binary. A binary file must never be silently
  # skipped, so fall back to scanning its full staged content as bytes through grep.
  numstat="$(git diff --cached --no-color --no-ext-diff --no-renames --numstat -- "$f" 2>/dev/null)"
  added="$(printf '%s' "$numstat" | cut -f1)"
  if [ "$added" = "-" ]; then
    if git show ":$f" 2>/dev/null | grep -Eq "$PATTERN"; then
      hits="${hits}  ${f} (binary, full staged content)"$'\n'
    fi
    continue
  fi

  # Added-lines-only scan: -U0 (zero context) unified diff against HEAD. A line
  # beginning with '+' is an addition; the '+++ b/path' file-header line also
  # begins with '+++' and must be excluded explicitly (both greps use -E so the
  # '\+' escaping means literal plus in both, not the GNU BRE one-or-more
  # extension that a bare `grep -v` would apply to it).
  addedLines="$(git -c color.ui=false diff --no-color --no-ext-diff --no-renames --cached -U0 HEAD -- "$f" 2>/dev/null | grep -E '^\+' | grep -Ev '^\+\+\+')"
  if [ -n "$addedLines" ] && printf '%s\n' "$addedLines" | grep -Eq "$PATTERN"; then
    count="$(printf '%s\n' "$addedLines" | grep -Ec "$PATTERN")"
    hits="${hits}  ${f} (${count} added line(s) matching the pattern)"$'\n'
  fi
done < <(git diff --cached --name-only -z --diff-filter=ACMR --no-renames)

if [ -n "$hits" ]; then
  {
    echo "BLOCKED: staged files add a Postgres connection string or PG_DSN= assignment."
    echo "Move secrets to mcp/job-search/.env (gitignored); only .env.example may hold placeholders."
    printf '%s' "$hits"
  } >&2
  exit 2
fi
exit 0
