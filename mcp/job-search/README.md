# job-search MCP server

Node MCP server that crawls job boards, deduplicates, and indexes listings into
the existing `ic_context` Postgres database, handing Claude a compact, capped
summary instead of page snapshots. Claude keeps the judgment work (fit scoring,
review decisions); the server does the mechanical work (crawling, dedup,
budgets, document preflight and rendering, follow-up reminders).
Design: `~/.claude/plans/plan-it-well-and-eager-wilkes.md` (rev 3).

Status: all four build stages landed (schema, dedup, embeddings, safety
harness, ten tools, adapters, scheduler, CLI, skill integration), plus a
scan-tuning pass (noise classification, title/location normalization fixes,
state/remote dedup, sorted detail-fetch ordering, indeed rate limiting, and
the daily scan report) after the first full six-source run against a real
scan Chrome. See "Known blind spots".

## Layout

```
mcp/job-search/
  package.json        plain JS ESM, // @ts-check, no build step
  .env.example        copy to .env (gitignored); config.js loads it itself
  config/             adapters.json ats-boards.json exec-boards.json company-aliases.json
                      alert-senders.json noise-rules.json noise-fixtures.json style-checks.json
                      triage.json triage-output-schema.json triage-mcp-empty.json
                      triage-candidate.md (gitignored, personal data, not committed -- see "Auto-triage")
  config.lock.json    sha256 of the ten config-locked files (six original plus four for slice 3
                      auto-triage); unattended runs refuse a mismatch
  sql/                001-011 migrations (each BEGIN/COMMIT, idempotent) + unique_indexes.sql (conditional)
  bin/                scan.js  migrate.js  backfill-embeddings.js  config-lock.js  remind.js
                      dashboard.js  seed-opportunities.js  triage-backfill.js
  seed/               opportunities.example.json (synthetic; the real file is gitignored under data/)
  scripts/            register-dashboard-task.ps1
  src/server.js       MCP server (stdout carries JSON-RPC frames only)
  src/tools/          search_jobs query_jobs get_job mark_jobs profiles scans review render_doc
                      followups scan_report
  src/core/           config db logger errors normalize dedup upsert prescore noise compact embed
                      urlguard budget ratelimit scheduler scan-run google followups remind report render schema
                      statuses events manual documents calendar-provider startup reembed triage
  src/dashboard/      http router server stream scan-runner calendar-cache task-names
                      next-scheduled-scan routes/*.js public/index.html (front end lands in PR 3)
  src/browser/        session (the only playwright import) capability extractors wall
  src/adapters/       index base greenhouse lever workday dayforce indeed linkedin exec-generic
  test/               node --test (fixtures under test/fixtures/)
  logs/               gitignored; scan/remind/dashboard-YYYY-MM-DD.log
  output/reports/     gitignored; daily scan-report markdown and HTML (YYYY-MM-DD-scan-report.{md,html})
```

## Setup

```
cd mcp/job-search
npm install
copy .env.example .env      # edit if the DSN, CDP port, or Ollama URL differ
node bin/migrate.js --check # no writes: schema gaps, collision groups, note candidates, conflicts, review-queue invariant
node bin/migrate.js         # apply; exit 2 means legacy conflicts are queued and unique indexes were skipped
npm test
```

Environment variables (defaults in `src/core/config.js`):
`PG_DSN`, `SCAN_CDP_URL` (dedicated scan Chrome, default `http://127.0.0.1:9333`,
never the daily-driver 9222), `SCAN_PROFILE_DIR` (default
`C:\Users\<you>\chrome-scan-profile`), `CHROME_EXECUTABLE`, `OLLAMA_URL`,
`OLLAMA_MODEL`, `JOBSEARCH_LOG_DIR`, `JOBSEARCH_CONFIG_DIR`, `LOG_LEVEL` are all
optional. `GOOGLE_TOKEN_FILE` and `REMINDER_TO` have **no default** (both
default to `''` in `config.js`) and must be set in `.env` before
`bin/remind.js` or the `followups` tool's calendar sync will work; leaving
either unset fails visibly (`VALIDATION` from `remind.js`, `AUTH_UNAVAILABLE`
from the Gmail adapter and the calendar provider) rather than silently
falling back to a real path. Real values live only in `.env` (gitignored via
`**/.env`); `.claude/hooks/pre-commit-secret-grep.sh` is a Claude Code
PreToolUse hook (registered in `.claude/settings.json`, matched on the Bash
and PowerShell tools), not a git pre-commit hook, and it blocks connection
strings in any staged file other than `.env.example` before Claude Code runs
a `git commit`. It only guards commits made through Claude Code; a commit run
from a plain terminal (outside Claude Code) bypasses it entirely.

The server is registered in the repo root `.mcp.json` (no env block, no
secrets) and its tools are allowed in `.claude/settings.json`
(`mcp__job-search__*`). Claude Code starts it with cwd = the repo root and
`CLAUDE_PROJECT_DIR` set; `config.js` resolves every path from there.

## The ten tools

| Tool | Purpose |
|---|---|
| `search_jobs` | run one scan (profile, sources, window); returns stats plus at most 25 compact rows; `locked` instantly when another scan runs |
| `query_jobs` | list stored rows (filters, sort, paging); excludes duplicates, expired rows, and notes by default; `noiseClass` filter narrows (never hides by default) |
| `get_job` | one row with URL, notes, and a description slice inside an untrusted-content delimiter; `fetchIfMissing` for fetch-backed sources only |
| `mark_jobs` | set status / fit_score / notes on up to 25 rows; re-embeds changed notes; resolves an open review item as separate |
| `profiles` | list or upsert search profiles (`exec-default` is seeded from `data/profile.md`) |
| `scans` | run status, per-source disable state, `enable_source`, `cancel` |
| `review` | list and resolve dedup review items (`merge`, `separate`, `repost`) |
| `render_doc` | preflight and render resumes, cover letters, and cheat sheets through the repo's Python converters |
| `followups` | create / list / complete / snooze / cancel follow-up threads; optional calendar event |
| `scan_report` | on-demand version of the daily scan-report email for a date or `run_id`; never advances the report marker |

Compact row shape: `#412 | CTO | Mercy Ships | Houston, TX (hybrid) | 2026-08-21 | $250-300k | ps 72 | new | linkedin | noise:<class>`
(the trailing `noise:<class>` segment appears only when the row's `noise_class` is not `ok`/`ok_manual`).
Every response is capped at 6000 characters; `truncated:true` plus a `hint`
tells the caller how to page.

## Scanning

### From Claude (MCP)

The `/scan-jobs` skill drives it: `profiles` (confirm `exec-default`), `scans`
(lookback from the last run), one `search_jobs`, `get_job` per new row above
the prescore threshold, one `mark_jobs` for the batch, then `review`.
`search_jobs({profile:'exec-default', sources:['greenhouse','lever'], dryRun:true})`
is the safe first call. `wait:false` returns `{run_id}` at once; poll with
`scans({action:'status', run_id})`.

### From the command line / Task Scheduler

```
node mcp/job-search/bin/scan.js --profile exec-default [--sources a,b] [--days N] [--max-pages N]
     [--min-prescore N] [--dry-run] [--json [out]] [--launch-chrome] [--accept-config-change]
```

Exit codes: `0` ok, `2` partial or locked, `1` failed (including
`CONFIG_LOCK_MISMATCH` and unknown sources). Logs JSONL to
`logs/scan-YYYY-MM-DD.log` (14-day retention); `--json` with no path writes
the full response under `logs/`. Ctrl-C (SIGINT) or SIGTERM aborts the run:
pages are closed, the run row is marked failed with `CANCELLED`, and the
advisory lock is released.

Unattended runs refuse to start when `config/*.json` differs from
`config.lock.json` (exit 1, `CONFIG_LOCK_MISMATCH`). After an intentional edit run
`node bin/config-lock.js --write` and commit both; `--accept-config-change`
overrides for a single run.

A genuinely offline first run uses only the fetch adapters:
`--sources greenhouse,lever,workday`. `--dry-run` skips every database write
for listings, queue, run items, adoption, and expiry; the run row and the daily
budget counters are still written because the network activity is real.

### The dedicated scan Chrome profile

Browser-backed sources (`indeed`, `linkedin`, exec boards with `mode: "browser"`)
attach over CDP to a separate Chrome profile at `SCAN_CDP_URL`
(default port 9333). Never the daily-driver instance on 9222; `--launch-chrome`
refuses 9222 and any non-loopback host outright.

One-time setup:

1. Start the profile (shortcut or command; the directory is created on first start):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\<you>\chrome-scan-profile" --remote-debugging-port=9333
   ```
   or `node mcp/job-search/bin/scan.js --launch-chrome --dry-run --sources greenhouse`, which reads
   `CHROME_EXECUTABLE` and `SCAN_PROFILE_DIR`, launches Chrome, and waits up to 20 s for CDP to answer.
2. In that Chrome window, log in to LinkedIn and Indeed once by hand. The
   profile keeps the session; the scanner never types credentials.
3. Leave that Chrome running when a scheduled scan is expected. When it is
   down, the run degrades to `partial` with `BROWSER_UNAVAILABLE`; fetch sources
   still complete.

Detail fetches on LinkedIn and Indeed (prescore >= 55 for these two sources,
per-adapter `detailFetchMinPrescore` in `config/adapters.json`; other sources
stay at the run-level default of 40; under the daily details budget) appear as
job views on that account. Detail fetches for a source run only after every
list page for that source has been collected, in descending (noise-weighted)
prescore order, so a limited daily details budget is spent on the
highest-value rows first rather than in page-arrival order; a row whose
detail fetch is skipped for budget reasons is still stored (without a
description) and marked `detail_skipped` (visible on `get_job`), and the
run's `detail_skipped_budget` stat counts how many. A login wall, Cloudflare
challenge, reCAPTCHA, or HTTP 403/429 stops the source and disables it across
runs (24 h, then 72 h, then manual: `scans({action:'enable_source', source})`).
Indeed additionally caps itself to 12 list pages per run (`maxPagesPerRun`,
independent of the daily and per-query caps) and keeps its per-request delay
at `delayMs` 4000-9000 ms (unchanged from before this pass; an earlier draft
of this change mistakenly lowered it to 2500-5500 ms, the wrong direction for
R5's actual goal of slowing Indeed down) to reduce the chance of a 429
mid-run.

### Sources and boards

`config/ats-boards.json` lists the Greenhouse boards, Lever companies, Workday
tenants, and Dayforce clients that are scanned (eight Greenhouse boards and
one Lever company verified live; the rest disabled with comments).
`config/exec-boards.json` lists the executive-search boards for the exec-generic
adapter; every entry ships disabled with a `comment` explaining what is
unverified. A wrong `listUrl` fails closed (`CONFIG_INVALID`). Per-adapter
delays, daily page/detail caps, per-query page caps, and the per-run
planned-page cap live in `config/adapters.json`.

Planned pages = (keywords + phrases) x locations x pages per browser source,
plus one page per keyword x location for each fetch source; the run is
refused with `BUDGET_EXCEEDED` when that exceeds `run.maxPlannedPagesPerRun`
(200). The trimmed `exec-default` profile (9 terms x 3 locations x 2 pages
over three fetch sources, two browser sources, and gmail) plans 191 pages,
so adding a term, a location, or a source needs a cap review. `gmail` is exempt from this multiplication
(see "Gmail job alerts" below): it plans one page count regardless of how
many terms and locations the profile carries.

### Noise classification, title cleanup, and state/remote dedup

Every listing gets a `noise_class` (recomputed on upsert and, for every existing row still missing one,
by `bin/migrate.js apply`'s `backfillNoiseClass()`, which classifies in batches and prints a per-class
count -- run once against the real database as of this pass: 650 rows total, 547 `ok`, 28
`aggregator_repost`, 25 `suspect`, 18 `ok_manual`, 17 `fractional_or_founder`, 12 `unknown_source`, 3
`staffing_generic`): `ok`, `ok_manual`, `aggregator_repost`, `fractional_or_founder`,
`staffing_generic`, `unknown_source`, or `suspect`. The rule set is
config-locked (`config/noise-rules.json`, rules evaluated by an explicit
integer `priority`, never file position) and linted on every `config-lock`
run against named fixture cases in `config/noise-fixtures.json`, so a rule
edit that silently changes a known case fails closed. `prescore_raw` (the
original, unweighted score) is stored alongside `prescore` (the noise-class-
weighted score used for ranking and the detail-fetch gate); nothing is hidden
from `query_jobs` or the database by default (only the daily report's "Look
at these" section excludes non-`ok` rows, and it prints how many it excluded).
A `NULL` `noise_class` (a row some other write path inserted without
classifying, since the backfill above should leave none) is treated as
not-ok too, never silently passed as `ok`: both `suspect` and `NULL` rows
surface in the report's own "Suspect / unclassified" section instead.

`normalizeTitle`/`normalizeListing` strip zero-width/format characters, a
known trailing source-UI fragment (LinkedIn's verified-badge text, `"<title>
with verification"`; the list lives in `config/adapters.json`'s
`titleTrailingFragments`, total classification -- an unlisted trailing
fragment is left in place, never guessed at, and a successful strip is
logged at debug for audit visibility), and a duplicated leading boilerplate
segment before tokenizing. The repeated-segment strip covers both the
space-delimited shape (LinkedIn's `"Field CTO\nField CTO with..."` pattern)
and a whole-string repeat with no separator at all (`"Chief AI
Transformation OfficerChief AI Transformation Officer"`); the floor for
either shape is a single word only (scan-report-fixes item 2 narrowed this
from "under 12 chars AND under 2 words" -- a real short 2-word repeat like
`"Field CTO Field CTO"` now collapses correctly to `"Field CTO"`; a
single-word coincidence like `"CTO CTO Group"` still never gets mangled).
Title cleanup caps the stored title at 200 chars, and separately recognizes
a bare US state name or abbreviation ("Texas") as a location on its own,
distinct from a city. That last piece feeds a dedicated dedup rule:
identical company + title postings that are both remote or both a state-only
location (no city), posted within 14 days of each other, merge automatically
(never queued for review) -- the "same role broadcast once per state"
pattern. `bin/migrate.js` re-normalizes every existing listing's title/
location/hash and backfills this merge rule against the open review queue.

### Auto-triage

After every non-dry-run scan (whatever triggered it: the `search_jobs` MCP tool, `bin/scan.js`, or the
dashboard's spawn of `bin/scan.js` -- all three converge on `executeRun()` in `src/core/scan-run.js`,
which is where the call lives, one call site reached by every trigger), `src/core/triage.js` routes the
obvious cases so the Untriaged queue only holds rows that genuinely need a human look. It runs AFTER the
scan's own advisory lock releases, on a fresh connection, so a slow model step never blocks a second scan.
A row with an open, unresolved review-queue item is never touched (its resolution stays a human decision).
Every automated change lands as an `ic_job_events` row with `actor='auto'`, so it is visible in the
listing history and reversible through the existing `mark_jobs` tool or dashboard status controls,
exactly like a human mark, except that only the event `actor` (never `marked_at`, which auto-triage sets
identically to a human mark) can tell them apart.

**Deterministic step** (`runDeterministicTriage`, gated by `config/triage.json`'s
`deterministic.enabled`): a total classification of every row this run touched that a human has not yet
marked --

- `noise_class` not `ok`/`ok_manual` (including `NULL`) -> `status='skip'`
- `noise_class` ok and `prescore < floor` -> `status='skip'`
- `noise_class` ok and `prescore >= ceiling` -> `status='new'`
- `noise_class` ok, `prescore` between `floor` and `ceiling` (or `NULL`) -> left untriaged, eligible for
  the model step below

**Model step** (`runModelTriage`, gated by `config/triage.json`'s `model.enabled`, off by default until
verified): the plausible middle band is batched (10-20 ids per call, capped per run) into a tool-free
`claude -p --output-format json --json-schema ... --strict-mcp-config --mcp-config config/triage-mcp-empty.json`
call, prompted with `config/triage-candidate.md` (a plain-text candidate summary, never committed --
personal data) and the search profile. Every listing field in the prompt is framed as untrusted data, not
instructions; a batch is validated against a strict ladder (unknown/duplicate ids, out-of-range scores, or
a non-zero exit all reject the WHOLE batch, applying none of its marks) before any mark is written. A
`status='skip'` recommendation with `fit_score >= skipMaxFit` is downgraded to `maybe` rather than trusted
outright.

**Enabling model scoring:**
1. Create `mcp/job-search/config/triage-candidate.md` (plain text, a few paragraphs describing the
   candidate) -- gitignored, never commit it.
2. Set `"model": { "enabled": true }` in `config/triage.json`.
3. Run `node bin/config-lock.js --write` and commit the updated `config.lock.json` (the candidate summary
   file itself is still config-locked for hash purposes only, per the "config drift must be deliberate"
   rule every config file gets -- editing it without re-running `config-lock.js --write` fails the next
   scan's lock check).

A missing `config/triage.json`, a missing/blank candidate summary, or any model-step failure never blocks
or fails the scan -- only a loud report line (below). A present but malformed `triage.json` still fails
the scan the same way a malformed `noise-rules.json` does today.

**Report line.** The daily report (`src/core/report.js`) prints one guarded line per run when
`stats.triage` is present, for example `triage: 12 auto-skipped, 3 auto-new, 8 sent to model, 8 scored`,
distinguishing "not configured", an ordinary run, a failed model batch, a batch that scored nothing (an
anomaly worth checking the prompt over), and model scoring deliberately disabled.

**Finding auto-triaged rows in the dashboard.** The Jobs page Filters modal has a dedicated "Auto-triage"
section with a "Show only rows triaged by auto" checkbox, serialized as `triagedBy=auto`, so
auto-skipped/auto-newed/model-scored rows stay discoverable beyond the daily report line. Rows that have
never been triaged at all, by auto or by a human, are reachable via the separate "Untriaged (never
triaged)" toggle in the same Status section.

**Backfill.** `bin/triage-backfill.js` is a one-time (or as-needed) catch-up for the backlog that
predates auto-triage, or any run where the triage step never ran or failed: nightly scans only triage the
rows their own `run_id` touched, so an older run's untriaged rows are never revisited on their own. The
script finds every historical `run_id` that still has at least one live, non-duplicate, untriaged listing
attached to it and replays `runTriage()` for each, reusing the exact same deterministic and model steps a
nightly scan uses, with no separate classification logic. `node bin/triage-backfill.js --dry-run` reports
per-run branch counts (skip_noise, skip_low, auto_new, model_band, has_open_review, other) without writing
anything or calling `claude`; the live form writes marks exactly as a scan does and merges each run's
stats into `ic_scan_runs.stats.triage_backfill`. `--limit-runs N` stages the rollout across several
invocations. Safe to re-run: a row a previous pass (or a human, or a nightly scan) already touched
reclassifies to `already_marked` or another terminal branch and is left alone. Run it when no nightly scan
is in flight; the model step has no per-row lock of its own.

### Gmail job alerts

`gmail` reads job-alert digest emails from the owner's own inbox and turns
them into listings through the same dedup, prescore, and review path as
every scanned source. It needs no scan Chrome (`needsBrowser: false`,
listed in `OFFLINE_SOURCES`) and no ATS board list; instead it needs a
sender list and a Google OAuth grant.

**Auth reuse.** Exactly the pattern `remind.js` already uses:
`src/core/google.js`'s `readTokenFile` reads the workspace-mcp OAuth token
file (`GOOGLE_TOKEN_FILE`, no default, set it in `.env`, e.g.
`C:\Users\<you>\.google_workspace_mcp\credentials\<your-google-email>.json`)
**read-only**, `makeOAuthClient` + `getAccessToken` refresh the access token
in memory, and the file is never written back. The scope check is new
(`assertScopes({gmailRead:true})`): it passes when the token carries
`gmail.readonly` **or** `gmail.modify` (send is not required and is never
checked for this source). A missing token file, a missing scope, or a 401
on any Gmail call yields one `AUTH_UNAVAILABLE` warning and the source
stops for the rest of the run (same as `BROWSER_UNAVAILABLE`: the run
degrades to `partial`, every other source still completes). There is no
per-message retry on a 401.

**`config/alert-senders.json`** is the sender allow-list, keyed by the
exact `From` address (never a display name, never a substring match):

```json
{ "senders": [
  { "address": "jobalerts-noreply@linkedin.com", "parser": "linkedin", "enabled": true, "comment": "..." }
] }
```

`parser` is a closed enum backed by `src/adapters/gmail-parsers.js`
(`linkedin`, `indeed-alert`, `indeed-match`, `lensa`, `ladders` today); an
address mapped to a parser name that does not exist fails config validation
(`CONFIG_INVALID`), never silently. Adding a new alert sender is a config
edit plus a new parser function, not a change to `gmail.js` itself. The
Gmail search query is built from every *enabled* entry:
`newer_than:<N>d (from:a OR from:b OR ...)`, where `N` is
`max(profile.posted_within_days, 14)` so the mailbox window is always at
least two weeks (decoupled from job freshness; the usual `postedAt`
window filter still drops anything actually stale).

**What is and is not modified in Gmail.** Every request is a `GET` to
`/gmail/v1/users/me/messages` or `/gmail/v1/users/me/messages/<id>`; the
URL guard's `pathPatterns` for `gmail` admit nothing else, and `gmail` is
not in `urlguard.POST_ALLOWED`, so a POST is refused before it can reach
the network. The adapter never applies a label, never marks a message
read, never archives, never sends. Re-scanning the same messages across
runs is safe and idempotent: the same alert yields the same listing (or an
update to the same row), never a duplicate label or a mutated inbox state.

**Quota.** `dailyPages: 300`, spent one page per `messages.list` call *and*
one page per `messages.get` call (list page size 50, so a full page can
spend up to 51). This is the owner's own per-user Gmail API quota; unlike
a scraped source's wall/backoff state, it is **not** disabled across runs
on a 429/503 -- the existing rate limiter backs off within the run
(`ADAPTER_ABORTED` -> `partial` if it still fails) and the quota simply
resets the next day.

**Operator steps after this lands** (not part of the code change):

1. Add `gmail` to the seeded `exec-default` profile's `sources` via
   `profiles({action:"upsert", profile:{name:"exec-default", sources:[...,"gmail"]}})`.
2. Add the spelled-out form of every abbreviation-only keyword to the
   profile (e.g. add `"Chief Technology Officer"` alongside `"CTO"`). The
   adapter already matches a title against the profile in both directions
   (`titleMatches(title, profile)` and, separately,
   `titleMatches(normalizeTitle(title).title_norm, profile)`, so a title
   that reads as the bare acronym still matches a spelled-out profile
   keyword) -- but the reverse direction (a fully spelled-out real title
   against an abbreviation-only keyword) is not covered by that
   normalization, since only the title side is expanded. Spelling out the
   keywords closes that gap.

### Task Scheduler (weekdays, random delay, interactive logon)

Run from an elevated PowerShell. Both tasks run as the interactive user, not
"whether user is logged on or not", so the scan Chrome is reachable.

```powershell
$root = "C:\claude-interview-coach\claude-interview-coach"

$a = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\scan.js --profile exec-default --json" -WorkingDirectory $root
$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 06:30
$t.RandomDelay = "PT45M"
Register-ScheduledTask -TaskName "job-search scan" -Action $a -Trigger $t -RunLevel Limited

$a3 = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\confirm.js" -WorkingDirectory $root
$t3 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 07:45
Register-ScheduledTask -TaskName "job-search confirm" -Action $a3 -Trigger $t3 -RunLevel Limited

$a2 = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\remind.js" -WorkingDirectory $root
$t2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 08:00
Register-ScheduledTask -TaskName "job-search remind" -Action $a2 -Trigger $t2 -RunLevel Limited
```

`Get-ScheduledTaskInfo "job-search scan"` shows the last run time and result
code (`0`, `1`, `2` as above). All three scripts prune their own logs after 14
days. `job-search confirm` (apply pipeline slice 7, `bin/confirm.js`) is
scheduled BEFORE `job-search remind` on purpose: it watches Gmail for
application confirmation/rejection/position-closed mail (see
"Apply pipeline: mail classifier and confirmation" below) and completes a
submitted application's 5-day nudge follow-up the moment it confirms, so that
follow-up never shows up as "due" in the same morning's `remind` digest.
`job-search confirm` is a standalone job, not a step inside `remind.js` --
its own failure mode (a broken Gmail query silently under-classifying mail)
is unrelated to the digest email, it keeps its own idempotency ledger
(`ic_gmail_processed_messages`), and every other apply-pipeline background job
in this codebase (the Workday verify-email poll, `src/apply/gmail-verify.js`)
is already its own self-contained module rather than threaded through
`remind.js`.

## Daily scan report and follow-up reminders

`bin/remind.js [--dry-run] [--to addr]` now sends one combined digest
(follow-ups plus the daily scan report) whenever EITHER is true: a follow-up
is due, OR at least one scan run has finished since the last report was sent,
OR (on a weekday with zero runs recorded at all) the run is silent -- that
last case sends anyway with a `[NO SCAN]` subject prefix, so a broken
scheduled scan is visible instead of producing quiet silence. A run whose
`status` was not `ok` gets a `[SCAN <STATUS>]` subject prefix. Zero due
follow-ups no longer suppresses the email by itself.

The scan-report portion covers, in order: run summaries since the last report
(status, duration, fetched/new/updated/repost/ambiguous, errors, per-source
pages); "Look at these" (top `run.reportTopN`, default 10, by prescore among
rows first seen since the last report, strictly limited to `noise_class` `ok`/
`ok_manual` -- a `NULL` class is excluded here too, not treated as passing --
with a count of how many were excluded); "Suspect / unclassified" (a short,
separate, bounded list of `suspect` and `NULL`-`noise_class` rows from that
same window, visible rather than silently dropped); "Houston / Texas" (same
window, filtered to the `exec-default` profile's home locations, any
prescore); the open review-queue count with its top 5 reasons; and currently
disabled sources. The email is plain text plus HTML; every listing field is
HTML-escaped and a URL is shown only when it passes a structural urlguard
check. The same report is written to
`output/reports/YYYY-MM-DD-scan-report.md` (gitignored via the existing
`/output/` entry), overwritten on a same-day re-run. Ask for the same content
on demand, for a specific date or `run_id`, with the `scan_report` MCP tool
-- it never advances the report marker, so it cannot cause the scheduled
email to skip or duplicate content.

`followups` stores threads such as "phone Nina Guthrie Thu 2026-08-27 if silent"
as rows in `ic_followups`; `bin/remind.js` selects open rows due within one
day (plus snoozed rows whose `snoozed_until` has passed, which are flipped
back to open) for the follow-ups section. `reminded_at` and the report marker
(`ic_report_state.last_report_sent_at`) are both stamped only after a 2xx
send, so a failed send is retried the next day and no report window is lost.

Auth model: no Gmail app password anywhere. The script reads the
workspace-mcp OAuth token file (`GOOGLE_TOKEN_FILE`, no default, set it in
`.env`, e.g.
`C:\Users\<you>\.google_workspace_mcp\credentials\<your-google-email>.json`)
read-only, refreshes the access token in memory with `google-auth-library`,
and never writes the file back (workspace-mcp owns it). Token values are never
logged; only `has_refresh_token`, `scopes_ok`, and `expiry`. Missing file or a
missing `gmail.send` / `calendar.events` scope: exit 1 with the file name and
the missing scope. `--dry-run` exercises the token and prints the combined
digest (including the plain-text report body) without sending or writing the
marker.

Exit codes: `0` sent or nothing to report, `1` auth or send failure (rows and
the report marker stay un-stamped).

### Google auth health (classification, caching, and where it surfaces)

`src/core/google.js`'s `classifyGoogleTokenState(tokenFile, need)` turns a raw refresh failure into one
of a fixed set of states -- `ok`, `broken_missing_file`, `broken_malformed`, `broken_no_refresh_token`,
`broken_missing_scopes`, `broken_invalid_grant`, `broken_refresh_error` -- instead of one generic
"not connected" banner. It never logs or returns a token value, only the classification. Every surface
below reads the SAME single live check per invocation/request, never a duplicate refresh attempt:

- **Dashboard calendar banner** (Home and Calendar pages): `GET /api/calendar/agenda`'s
  `connected:false` response carries `reason` (the state slug) and `hint` (a fixed message per state).
  `src/core/calendar-provider.js` caches a successful connection for up to ~50 minutes but caches a
  BROKEN classification for only 5 minutes (`DEFAULT_BROKEN_COOLDOWN_MS`), so a dead grant is re-checked
  far sooner than a healthy one, without hammering a refresh attempt on every dashboard poll in between.
- **Daily report** (email and the `scan_report` tool): a "Google auth: ..." line, HTML-escaped like every
  other report field.
- **`bin/remind.js`**: on a broken classification, still attempts the send (there is nothing to lose by
  trying); on failure it logs one ERROR-level `google_auth_broken` line (distinct from the ordinary
  info-level `remind_token_failed` line) and, specifically for `broken_invalid_grant`,
  `broken_no_refresh_token`, or `broken_missing_scopes`, opens/refreshes the dashboard tab
  UNCONDITIONALLY (not gated on `--open-dashboard`) -- the dashboard is the one delivery channel that
  does not depend on the dead grant.
- **`gmail` adapter pre-flight**: a pre-flight auth failure (before any Gmail API request) carries the
  classification in its `AUTH_UNAVAILABLE` warning. A MID-run 401 on `messages.list`/`messages.get` is
  explicitly out of scope and keeps its existing generic treatment.

**Troubleshooting a recurring broken grant** (`broken_invalid_grant`, the empirically confirmed real-world
failure this hardening was built against -- a live expired grant, `err.response.data.error ===
'invalid_grant'`):

1. **The consent screen is in Testing mode.** A Google OAuth app left in Testing mode expires every
   refresh token after 7 days, regardless of use -- this is the single most likely cause of a grant that
   keeps dying on a weekly cadence. Fix: in Google Cloud Console, publish the OAuth consent screen to
   **Production**. (Re-run the workspace-mcp auth flow once after publishing to obtain a token issued
   under the new setting; existing Testing-mode tokens do not retroactively stop expiring.)
2. **`redirect_uri_mismatch` after the local callback port drifts.** workspace-mcp's local OAuth callback
   server resolves its port with a fallback range (8000-8004) when its preferred port is busy; if only
   one exact port is registered as an authorized redirect URI in the Cloud Console OAuth client, a run
   that falls back to a different port in that range fails the auth flow with `redirect_uri_mismatch`.
   Fix: register `http://localhost:8000/` through `http://localhost:8004/` (all five) as authorized
   redirect URIs on the OAuth client, not just the one port that happened to work the first time.

Neither fix is made by this repository or by `workspace-mcp` automatically; both are one-time manual
steps in Google Cloud Console.

## Dashboard

A local, loopback-only HTTP server (`src/dashboard/`) so most day-to-day job-search
actions (viewing the pipeline, running or canceling a scan, previewing or sending
the report, follow-ups, review, calendar) do not require a model in the loop. The
server, API, scan runner, SSE stream, seed script, and task registration script
shipped first; a plain HTML/CSS/JS front end (no build step) now serves from `/`
and covers every page listed below.

**Run it:**

```
npm run dashboard          # node bin/dashboard.js
npm run dashboard:open     # same, plus opens the URL in the default browser
```

Prints `http://127.0.0.1:7311/` (or whatever port is configured) once it is
listening. `http://localhost:7311` may resolve to `::1` on some resolvers; the URL
this process prints and binds always uses the literal `127.0.0.1` address.

**Port:** `DASHBOARD_PORT` in `.env`, default `7311`. Must be an integer
1024-65535 or the dashboard falls back to `7311` with a logged warning and a
`banner` entry in `GET /api/health`'s response. Only one instance runs at a time:
on `EADDRINUSE` the new process probes `GET /api/health` on that port and exits 0
(not an error) if a dashboard already answers there, exits 1 with a log line
naming the port and what answered otherwise.

**Task registration** (start automatically at logon):

```
npm run dashboard:register   # writes/updates the "job-search dashboard" scheduled task
Start-ScheduledTask -TaskName "job-search dashboard"
```

`scripts/register-dashboard-task.ps1` only writes the task definition; running
`Start-ScheduledTask` (and confirming it stays up across a reboot or log off/on) is
a separate, deliberate step for the operator, not something this repository does on
your behalf. `-ExecutionTimeLimit 0` (unlimited; Task Scheduler's 72-hour default
would otherwise kill a long-running server), `-MultipleInstances IgnoreNew`,
`RestartCount 3`. Unregister with `powershell -File
scripts/register-dashboard-task.ps1 -Unregister`.

**Seed file** (outside opportunities that never came from a scan -- a recruiter
call, a role already known before this repo tracked it):

```
node bin/seed-opportunities.js --dry-run
node bin/seed-opportunities.js
node bin/seed-opportunities.js --file path\to\file.json
```

Default path is `data/job-search/opportunities.json`, under the gitignored `data/`
directory -- not committed, and not created by this repository. See
`seed/opportunities.example.json` for the entry shape with synthetic company and
contact names: `key` (stable id; a re-run with the same key updates the same row
instead of creating a duplicate), `title`, `company`, `url?`, `status`, `notes?`,
`contact?`, `via?`, `match_listing_id?` (attach to an existing scanned row instead
of creating a manual one), `events?` (replayed with `actor:'seed'` and the given
`at`), `followup?` (`{link_id}` to attach an existing follow-up, or full fields to
create one), `documents?` (relative `output/` paths; a missing file warns, it never
fails the entry). Prints one JSON line per entry so a partial failure is visible
without aborting the rest of the file.

**What each dashboard action does** (server-side; see the front end in PR 3 for the
buttons that call these):

- **Run scan / Cancel scan**: `POST /api/scans` spawns `bin/scan.js --trigger
  dashboard --run-marker <path> --json <file>` as a **detached** process --
  restarting or stopping the dashboard never kills a running scan. The dashboard
  correlates the spawn to a run by that marker file's appearance, never by timing;
  see `src/dashboard/scan-runner.js`. `POST /api/scans/:id/cancel` flips the run
  row (same mechanism the `scans` MCP tool uses) and, only when this dashboard
  process itself spawned that run, arms a `taskkill /T /F` backstop 45 seconds
  later if it is still not finished -- a run this dashboard did not spawn (CLI,
  MCP, or a dashboard restart that lost the pid) gets the DB flip only, and the
  response's `forced_kill_available` tells the caller which applies.
- **Preview / Send report**: `GET /api/report/preview` calls the exact same
  `buildScanReport`/`resolveReportWindow` functions the `scan_report` MCP tool
  uses and **never** touches `ic_report_state`; `POST /api/report/send` runs
  `runRemind` on its own dedicated connection (never the pooled one, so a slow
  Gmail call cannot starve other requests).
- **Stage changes, notes, follow-ups, review resolution, manual opportunities,
  document links**: reuse `applyMark`, `createManualListing`, `resolveItem`,
  `core/followups.js`, and `core/documents.js` exactly as the MCP tools do, with
  `actor:'dashboard'` on every event so the history timeline and the MCP's own
  `listEvents` show who made a change.

**Live updates**: `GET /api/stream` is a Server-Sent Events endpoint (one process-
wide timer set, capped at 16 concurrent connections, `503` beyond that): `run`
every 2 s while a scan is live, `changed {kind}` within 10 s of any
`ic_job_events`/`ic_followups` row appearing (from the dashboard, the MCP, or the
CLI), and a `ping` every 25 s. The front end (PR 3) falls back to 5 s polling of
`/api/summary` after two SSE failures.

**Security standing constraint (iframe sandbox):** stored report and research HTML
is served through `GET /api/documents/file` with `Content-Security-Policy:
sandbox; default-src 'none'` and is rendered only inside a sandboxed `<iframe
sandbox>` with no `allow-*` tokens by the front end. **`allow-scripts` and
`allow-same-origin` are never added to that iframe together** -- that combination
lets a sandboxed page escape the sandbox via its own srcdoc; this holds regardless
of how trusted the HTML source looks, since a scan-derived research page embeds
whatever an external company's site returned before this project ever sees it.

**Config lock:** no new config file; `DASHBOARD_PORT` lives in `.env`/`.env.example`
only, same as every other environment override in this README.

### Front end (`src/dashboard/public/`)

Plain HTML, CSS, and ES modules, no build step and no external resources (fonts,
CDN scripts, or stylesheets) -- everything the browser loads comes from this
server, matching the CSP the guards already enforce. `lib/dom.js`'s `h()` (plus
`hSvg()` for charts and `hSandboxedIframe()` for report/research HTML) is the only
DOM construction path: every attribute name is checked against a closed allow
list, `.textContent` is the only place untrusted listing text ever reaches the
page, and a link's `href`/`src` is only ever written after the server's own
`url_ok` flag and a client-side scheme re-check both agree the URL is `http:` or
`https:`.

**Pages:** Home (status tiles, run/cancel scan, scan progress, agenda, recent
activity), Jobs (filterable table, including an Auto-triage filter, with bulk stage actions and 10 s
Undo), Job
detail (stage buttons, notes with 800 ms autosave, documents, follow-ups, history),
Pipeline (grouped list by stage, not a kanban board), Follow-ups (Overdue/Today/
This week/Later/Snoozed/Done), Review (candidate vs. matches with differing fields
highlighted, Merge/Separate/Repost), Runs and Run detail, Reports and Report view
(sandboxed iframe), Calendar (14-day agenda), Analytics (inline SVG charts, no
chart library), Companies and Company detail.

**Keyboard map** (disabled while an input/textarea/select or a content-editable
element has focus, except `Escape`; modifier-held keys such as Ctrl/Cmd/Alt are
never intercepted, so browser shortcuts always pass through):

| Keys | Action |
|---|---|
| `g` then `h` / `j` / `p` / `f` / `r` | Go to Home / Jobs / Pipeline / Follow-ups / Review (the `g` prefix arms a 600 ms window) |
| `/` | Focus the top bar search field |
| `j` / `k` (no `g` prefix) | Move a row cursor down / up, on Jobs, Pipeline, Follow-ups, Review, and Runs |
| `Enter` | Open the cursored row (Jobs/Pipeline: Job detail; Follow-ups/Review: the linked listing's Job detail, when one exists; Runs: Run detail) |
| `m` / `s` / `a` / `p` / `x` | Quick stage-set the cursored row to Maybe / Shortlisted / Applied / Passed / Skip, on Jobs and Pipeline only (Follow-ups/Review/Runs rows have no pipeline stage) |
| `1`-`0` (Job detail) | Set stage: New, Maybe, Shortlisted, Applied, Interviewing, Offer, Accepted, Passed, Lost, Skip, in that order. `Dead` and `Review` are reachable only through the "More stages" control, never a bare digit |
| `n` (Job detail) | Focus the notes field |
| `f` (Job detail, no `g` prefix) | Quick-create a follow-up tied to this listing (prompts for contact and days until due) |
| `?` | Toggle the keyboard shortcuts overlay; every key except `Escape`/`?` is swallowed while it is open |
| `Escape` | Close the overlay, or blur the focused field |

**Layout breakpoints**, watched live on resize, not just at initial load:

- **1181px and up:** the full layout (198px rail, six-tile Home row, eight-column
  Jobs table).
- **900px to 1180px:** the rail collapses to 56px with icon-scale labels, the top
  bar search field narrows, Home's tiles and scan-progress sources reflow to
  3-by-2, body columns stack to one, and the Jobs table drops a column.
- **Below 900px:** the entire page content is replaced with a single "widen the
  window" notice -- nothing from the normal rail/top bar/body renders underneath
  it. Widening back past 900px live-restores the normal layout without a reload.

**Front-end blind spots** (in addition to "Dashboard blind spots" below; static
analysis and `node:test` unit coverage cannot substitute for these):

- A computed/bracket-shaped DOM sink (`el["inner" + "HTML"]`, `el[sinkNameVar]`)
  would defeat every regex-based check in `test/dashboard-lint.test.js` by
  construction; the lint test enumerates every named sink it can grep for, but
  this class of evasion is a known, accepted gap of any static text scan, not
  something this PR claims to close.
- Real seeded/scanned data (long company names, long recruiter/via text, long
  titles) has not been run through the fixed-width Jobs table or the collapsed
  1100 breakpoint's narrower columns; the Playwright screenshots in this PR use
  whatever fixture data was in the test database at capture time, not a
  deliberately adversarial long-text fixture.
- Contrast ratios of the `-dim` chip backgrounds against their paired foreground
  colors (design reconciliation's own blind spot) were not measured against WCAG
  AA; they were carried through from the design token mapping as given.
- The SSE two-failure-then-poll fallback (`lib/sse.js`) and the notes-autosave
  flush-on-navigate rule (`pages/job-detail.js`'s `beforeLeave` hook) are exercised
  only by code review and manual reasoning about the state machine, not by an
  automated browser test that forces a real dropped connection or a real
  mid-debounce route change.
- The plan names `m`/`s`/`a`/`p`/`x` as row-level shortcuts without specifying
  what `p`/`a`/`x` individually do beyond "row down/up" (see the judgment call
  recorded in `lib/shortcuts.js`): they are wired as quick stage-set actions on
  Jobs and Pipeline (the only two list pages with a pipeline stage), and marked
  not-applicable everywhere else via each page's exported `KEYBOARD_ACTIONS`
  manifest (see `test/dashboard-public-kbaction-wiring.test.js` for the totality
  check across those manifests, and `scripts/capture-dashboard-screenshots.mjs`'s
  kbaction interaction pass for a real, driven-by-Playwright confirmation that
  `j` cursors a row, `Enter` opens it, a Job-detail digit sets the matching
  stage, `n` focuses notes, and `m` quick-sets a Pipeline row's stage). Not
  covered by either: `k` (up), `s`/`a`/`p`/`x` individually beyond `m`, the
  Follow-ups/Review "open the linked listing" path, and the Runs row-open path;
  these share the same code path as the ones that were checked (`lib/list-
  cursor.js`'s single `move()`/`current()` implementation) but were not each
  individually driven through Playwright.
- No automated accessibility audit (screen reader pass, full color-blindness
  simulation) was run; component states follow the design reconciliation's
  written rules (focus rings, disabled tooltips, loading skeletons) but were not
  independently audited.

**Dashboard blind spots** (in addition to "Known blind spots" below; none of these
is exercised by the test suite, which never touches the real Postgres database, a
real browser, or a real Task Scheduler task):

- Never run against the real `ic_context` database or a real browser session; SSE,
  the guard rules, and every route are exercised only against the isolated test
  database with stubbed calendar/scan-runner dependencies.
- Windows `taskkill /T /F` tree-kill semantics against a real, running scan
  (including its attached Chrome pages) are untested; the 45 s backstop's
  behavior against a wedged child process is unverified.
- `schtasks /query` XML/CSV parsing (`GET /api/summary`'s "next scheduled scan") is
  tested only against canned output fixtures; real output shape can vary by
  Windows locale, PowerShell version, and whether the "job-search scan" task has
  ever actually been registered with the exact trigger shape this parser expects.
- The Google Calendar provider is stubbed in every test; a real OAuth grant,
  real Calendar API pagination, and real event CRUD are unverified end to end.
- `bin/seed-opportunities.js` is tested against a synthetic fixture DB and the
  example JSON only; it has never been run against a real, populated
  `ic_context` database or the real (gitignored) `data/job-search/opportunities.json`.
- The scan-runner's LOCKED-vs-SCAN_START_FAILED classification depends on
  `bin/scan.js` exiting with code 2 specifically for a lock conflict before ever
  writing the marker file; this is correct by construction (a locked run never
  reaches the `ic_scan_runs` INSERT that the marker follows) but has not been
  exercised against a real second in-flight scan process.

## Apply pipeline: adapter coverage

`src/apply/adapters/index.js`'s `ADAPTERS` registry, keyed by `ic_job_applications.ats_type`
(`src/core/applications.js`'s `ATS_TYPES`). `src/apply/worker.js`'s adapter lookup is total: an
`ats_type` with no registry entry parks the application in `needs_human` (`unsupported_ats`), never a
throw or an assumed-ok skip -- `unknown` is the only value that will never get one, since it is
`classifyApplyUrl()`'s own default branch for a URL this codebase does not recognize at all.

| ATS | Account | Flow shape | Adapter |
|---|---|---|---|
| Greenhouse | none | single page | `greenhouse.js` (slice 5) |
| Lever | none | single page | `lever.js` (slice 5) |
| SmartRecruiters | none | single page | `smartrecruiters.js` (slice 6) |
| Workday | per-tenant, self-registers | multi-step wizard, email verify | `workday.js` (slice 6) |
| iCIMS | none (mandatory sign-in parks, never signs in) | single page | `icims.js` (slice 8) |
| Dayforce | per-tenant, sign-in only, never self-registers | multi-step wizard | `dayforce.js` (slice 8) |
| Indeed / LinkedIn Easy Apply | n/a | classify-only, deliberately never automated | `indeed-easy.js` / `linkedin-easy.js` |

Every browser-driving adapter's CSS/data-attribute selectors are this build's best understanding of that
ATS's public DOM, written and tested against a SCRIPTED FAKE page (see each adapter's own test file) --
none has been verified against a live tenant in this sandboxed environment (no real Chrome/network
available here). The failure mode on a wrong selector is safe by construction across every adapter: an
optional `waitFor` miss parks in `needs_human` rather than guessing.

**Confidence is a display hint, not a worker gate** (`src/apply/ats-detect.js`'s `classifyApplyUrl`):
`exact` / `inferred` / `low` drive only the dashboard's ATS chip. The actual automation gate is the human
Approve action on the application card (`POST /api/applications/:id/approve`) -- nothing runs the browser
against a real ATS page until a person has approved it, regardless of confidence tier. As of slice 8,
Dayforce's CandidatePortal path shape and iCIMS's `/jobs/<posting-id>...` path shape both classify `exact`
(an anchored structural match, same certainty class as Greenhouse/Lever's own canonical URL shapes); either
ATS with no recognizable posting path on the URL still classifies `low`.

### Salary routing

Every custom screening field an adapter answers checks the field's label against `src/apply/answers.js`'s
`SALARY_LABEL_RE` (an hourly- or annual-unit-shaped label) BEFORE the generic three-tier bank matcher runs.
A salary-shaped label always routes through `resolveSalaryAnswer()` instead: with a configured
`salary_floor` (`data/apply-answers.md`, gitignored personal data) and an unambiguous unit, it fills the
resolved figure; otherwise it parks a `question`-kind pending question, and no fill call for that field ever
carries a bare number. `salary_floor` ships deliberately unset in this repo -- see `data/apply-answers.example.md`.

### `/apply-answer` -- answering a parked screening question

`.claude/skills/apply-answer/SKILL.md` drafts an answer to one application parked in `needs_human` with a
`question`-kind pending question, strictly from this repo's own `data/` files, and posts it to
`POST /api/applications/:id/answer` only after explicit approval in the conversation (`--dry-run` never
posts at all). It handles the `question` kind only -- any other pending-question kind (`credential`,
`captcha`, `document_drift`, and so on) gets a short, non-actionable message naming the kind instead, since
those need a different action this skill does not perform. It never fills the application form itself; only
the dashboard-driven `src/apply/worker.js` does that, after this skill's own POST resumes the application.

## Document rendering (`render_doc`)

`render_doc({kind:'resume'|'cover_letter'|'cheatsheet', source, outName?, checkOnly?, force?, allowMissing?})`
runs the lexical preflight (em-dash, en-dash outside year ranges, scare quotes,
buzzword list from `config/style-checks.json`, problem-comparison reframe,
resume block structure for `md_to_docx.py`, role inclusion against
`data/project-index.md`, PMP wording, Jenkon title, output naming) and then
runs the matching converter (`tools/md_to_docx.py`, `tools/cover_letter_to_docx.py`,
`tools/cheatsheet_to_docx.py`) via `execFile` with file paths only. Output
goes to `output/resumes/`, `output/coverletters/`, `output/cheatsheets/`.
`LOCKED` when the DOCX is open in Word; `EXISTS` unless `force:true`; the file
is never opened afterwards. The `/write-resume`, `/write-cover-letter`, and
`/format-resume` skills call it with `checkOnly:true` first, then render.

## Tests

`npm test` (== `node bin/run-tests.js`) is the only supported way to run the suite. It NEVER touches the
real, shared `ic_context` database: `bin/bootstrap-test-db.js` first creates or refreshes a throwaway
`<name>_test` database (`ic_context_test` for the default local setup) by `pg_dump --schema-only` of the
configured real database, then re-applies this server's own SQL migrations (`sql/001-011`) against the
copy -- idempotent, so this also proves the migrations themselves are sound, not just that the schema
copy succeeded -- and seeds the `exec-default` profile from the deterministic fallback (never personal
`data/profile.md`). `bin/run-tests.js` then spawns `node --test --test-concurrency=1` with `PG_DSN` pointed
at that database, set via the child process's environment (not a shell-exported variable, so this works
identically on Windows and POSIX). Test FILES run serially (`--test-concurrency=1`), not in parallel:
several suites write real, shared singleton rows (`ic_report_state`, `ic_source_state`) even in the
isolated database, and serializing file execution is what makes those tests deterministic rather than
occasionally racing each other.

**Hard safety gate**: `bin/bootstrap-test-db.js` refuses to create, drop, or dump into any database whose
name does not end in `_test`, with no override flag. This exists because a bug in an earlier version of
this test-isolation work briefly wrote duplicate rows into the real, shared production database via a
plain `npm test` run, before this bootstrap existed; see the PR history for the incident. `PG_TEST_DSN`
can point the bootstrap at an explicit target (for CI); the same gate still applies to whatever it
resolves.

`node bin/bootstrap-test-db.js` refreshes the test database on its own, without running the suite (useful
after a schema change on the real database, so the next `npm test` picks it up without waiting through a
full run first).

**Second hard safety gate, at the point of connection**: `bin/bootstrap-test-db.js`'s gate above only
protects the *bootstrap* step. A DIFFERENT mistake -- running a test file directly with `node --test
test/x.test.js` instead of through `npm test` -- skips the bootstrap entirely, so `PG_DSN` resolves to
whatever `.env` already points at (the real, shared database, most of the time), and every query that
file's tests run goes straight to production with no warning. This happened once: a direct `node --test
test/report.test.js` / `test/migrate.test.js` run corrupted the real `ic_report_state` singleton row and
performed a real-data migration outside any tracked, deliberate invocation; it was caught and repaired by
hand, which is not a defense, just luck. `src/core/config.js`'s `pgConnectionConfig()` (the function every
database connection in this codebase is built from, including test files that construct `new
pg.Client(pgConnectionConfig())` directly rather than going through `src/core/db.js`) now calls
`assertTestDbGuard()` before returning: if the process is running under the Node test runner --
`process.env.NODE_TEST_CONTEXT` is set (Node's own `node --test` marker), any `process.argv` entry
contains `--test`, or `process.env.JOBSEARCH_TEST_GUARD === '1'` (set explicitly by `bin/run-tests.js` on
its spawned child, as a first-party backup to `NODE_TEST_CONTEXT` in case a future Node version stops
setting it) -- and the resolved database name does not end in `_test`, it throws immediately, before any
connection is opened, telling the caller to run tests through `bin/run-tests.js`. `src/core/db.js`'s
`getPool()`/`connectDedicated()` call the same guard again as a second, redundant layer. `test/config.test.js`
proves the guard actually trips (and does not false-positive) by spawning real child `node` processes with
each combination of these environment variables. **One consequence**: `LIVE=1 node --test
test/smoke-greenhouse.test.js` below now also requires `PG_DSN` to point at a `_test`-suffixed database
before it will run at all -- it is no longer possible to run it unisolated by omission.

The DB-backed suites use marker profiles/companies (`zz-test-*`, `ZZ-TEST-*`) and delete them afterwards,
on top of running against the isolated database; this is defense in depth, not the isolation mechanism
itself. Two suites need files that are gitignored in this repo (`data/project-index.md` for
`render_doc.test.js`), so they only pass in a checkout that has them.

`test/scenarios.test.js` covers the spec's end-to-end scenarios that need no
LinkedIn or Indeed: the same cross-source pair scanned three times yields
exactly two rows (root plus `duplicate_of`); a Python-inserted row that
duplicates a scanned URL is adopted at the next scan with one review-queue
entry and the run completes; a concurrent scan returns `locked` in under a
second; a closed CDP port yields `partial` plus `BROWSER_UNAVAILABLE`.
`test/adversary.test.js` holds the refusal cases for `classify()`, the URL
guard, wall classification, and the `render_doc` preflight.

`LIVE=1 PG_DSN=<a _test DSN> node --test test/smoke-greenhouse.test.js` makes one real Greenhouse
boards-api call. This one bypasses `bin/run-tests.js`'s bootstrap/isolation entirely, since it is a rare,
deliberate, opt-in manual check rather than part of `npm test`; it writes (with the usual
`zz-test-*`/`ZZ-TEST-*` marker-and-cleanup convention) to whatever database `PG_DSN` points at. `PG_DSN`
must point at a database whose name ends in `_test` -- `assertTestDbGuard()` (see above) now refuses to
connect otherwise, since this file also runs under `node --test`. Point it at your bootstrapped test
database (`node bin/bootstrap-test-db.js` creates/refreshes one on its own) rather than the real one.
Nothing else in the suite touches the network: fetch adapters
run over recorded fixtures (`test/fixtures/adapters/`) and browser adapters over
a fake capability. `test/har.test.js` records every request of a full fixture
run and asserts zero non-GET outside the Workday search POST and zero URLs
outside the registry patterns. `bin/scan.js` accepts
`JOBSEARCH_FIXTURE_MAP=<file.json>` (URL prefix to fixture file) so the CLI can
be exercised offline; `JOBSEARCH_CONFIG_LOCK` points the lock check at another
file for the same reason.

`LIVE=1 PG_DSN=<a _test DSN> node --test test/triage-cli-smoke.test.js` shells out to the real `claude`
binary once with auto-triage's exact flag set and asserts the returned envelope still matches the shape
`src/core/triage.js`'s `validateModelOutput` expects, so a future CLI version change that alters the
envelope is caught by a deliberate, occasional run rather than every production batch failing silently.
Same `_test`-suffixed-DSN requirement as the Greenhouse smoke test above; writes nothing to the database.

## Config lock

`node bin/config-lock.js` reports whether the config-locked files (`CONFIG_FILES` in `src/core/config.js`
-- the original six plus, since slice 3, `triage.json`, `triage-candidate.md`, `triage-output-schema.json`,
and `triage-mcp-empty.json`) match `config.lock.json` (exit 2 on mismatch). It also lints
`config/noise-rules.json` against the named fixture cases in `config/noise-fixtures.json` on every run
(check or `--write`), failing closed (exit 1) if any fixture's expected
`noise_class` no longer holds under the current rules -- this catches a
noise-rule edit that silently changes behavior for a known case, not just a
hash mismatch. After an intentional config edit run
`node bin/config-lock.js --write` and commit both.

`triage.json` is loaded tolerantly (a missing file loads with every field at its schema default, never
`CONFIG_INVALID`, see "Auto-triage" above), but it is still hashed here: a missing `triage.json`, and a
missing `triage-candidate.md` (gitignored, personal data, present only on an operator's own machine), both
hash to a fixed `<missing>` placeholder, so `config.lock.json` still needs a `--write` whenever either
file's presence or content changes on a given machine, same "config drift must be deliberate" rule every
other config file gets.

## Embeddings

`src/core/embed.js` mirrors `tools/ic_memory.py`: Ollama `/v1/embeddings`,
`mxbai-embed-large`, 1024 dims, text `"<title> at <company>. <notes>"`.
`node bin/backfill-embeddings.js` fills NULL embeddings in batches of 32;
`--all` re-embeds every listing row. A scan with Ollama down stores rows with
NULL vectors and reports `stats.unembedded`.

## Safety rules enforced here

- Adapters never import Playwright and never see a page, context, or browser;
  they receive a frozen capability object (`goto`, `readHtml`, `readJson` of
  named extractors, `scrollToBottom`). No click/fill/type surface anywhere in
  `src/` (`test/safety.test.js`).
- Every outbound request goes through the URL guard (registered domains and
  path patterns, https only, no non-default ports, DNS check, redirect
  re-check); non-GET only for the two path-scoped exceptions in
  `urlguard.POST_ALLOWED`.
- Pagination is URL construction only. Per-domain concurrency 1 with jittered
  delays; 429/503 back off exponentially to 5 min, three retries, then the
  adapter is aborted for the run.
- Walls (403/429, Cloudflare, reCAPTCHA, login paths) stop the source and
  disable it across runs (24 h, 72 h, then manual `scans({action:'enable_source'})`).
- Logging is enumerated scalars only (`logger.js` strips objects at the boundary); stdout is reserved for JSON-RPC frames.
- `raw` payloads are never persisted; the review queue stores a compact candidate snapshot.
- Unique indexes are created only when the review queue holds no open legacy conflicts.

## Known blind spots

From the design (sections 12b and 13) and the build reports; none of these is
detected by the test suite.

- Title rewrites on id-less sources still surface as new or ambiguous rows.
- Company variants beyond the suffix rules and `company-aliases.json` split;
  an over-broad alias silently merges two companies with no review path.
- Salary is parsed from `salary_raw` by a simple regex; salaries in prose are
  not extracted, so corroboration for list-only rows degrades to `posted_at`.
- Expiry is heuristic: `stale` marks the pagination boundary but cannot prove
  a role closed.
- Review-queue volume is unknown until real scans run; if it reaches hundreds,
  the 30-day auto-separate becomes the de facto classifier and the 0.55/0.70
  trigram thresholds need retuning.
- `description_hash` is NULL for list-only rows (detail not fetched), so
  corroboration rules that lean on it fall back to dates and salary.
- Live selectors and endpoints for Indeed mosaic JSON, LinkedIn markup,
  Workday cxs, Dayforce markup, and every exec board are from prior knowledge
  and synthetic fixtures; no browser adapter has run against a real Chrome.
- Locations: US "City, ST" is parsed; other strings classify as a country or an
  unknown hash, which prevents false merges but not false splits.
- Claude Code version gates auto-backgrounding and the 30-min idle timeout;
  `wait:false` is the fallback for long scans.
- Follow-ups are entered by hand; nothing reads Gmail to auto-close a thread
  when a contact replies.
- The reminder job depends on the workspace-mcp OAuth grant staying valid. A
  revoked or expired grant is now classified, cached, and surfaced loudly
  (dashboard banner with a reason and hint, a "Google auth" report line, an
  ERROR-level log line, and an unconditional dashboard-open trigger -- see
  "Google auth health" above) rather than showing up only as exit 1 on the
  next run with no explanation. The desktop-app client secret still sits in
  plaintext in that token file (an accepted, pre-existing exposure that
  `remind.js`, `gmail.js`, and the calendar provider all depend on); this PR
  does not change that. Real Google endpoint behaviors beyond the one live
  probe this PR's classifier was built against (a confirmed expired
  `invalid_grant`) are unverified: `invalid_client`, `access_denied`, rate
  limiting/quota errors, and any other structured OAuth error field are
  classified by the same logic but were never observed live, only
  constructed as test fixtures. The 5-minute broken-cooldown and ~50-minute
  success-cache windows are not empirically tuned against Google's own
  actual token-expiry or rate-limit behavior; they are the values the spec
  called for.
- `gmail`: alerts from senders not listed in `config/alert-senders.json` are
  invisible; a new job-alert source is a config edit, not a code change.
- `gmail`: an HTML-only or restructured email whose markup no longer matches
  its parser silently degrades to fewer or zero parsed listings
  (`PARSE_EMPTY`), never a crash of the source; nothing currently diffs a
  sender's real template against the parser's assumptions.
- `gmail`: job links behind a third-party click tracker (Lensa, the Indeed
  personalized match email) are stored as opaque residual URLs and are
  never fetched or resolved to the real posting; `get_job` cannot recover
  a description for these rows.
- `gmail`: a duplicate alert for the same job sent through two different
  senders (e.g. Lensa and LinkedIn for the same role) is recognized as a
  duplicate only when the normalized title, company, and location match
  exactly; text differences beyond that land in the review queue instead
  of merging automatically.
- `gmail`: no listing carries a description (list-only, digest email); every
  gmail-sourced row is permanently ineligible for a detail fetch (this
  adapter has none) and `get_job({fetchIfMissing:true})` is refused for it.
- `gmail`: the sender allow-list and the Gmail search query only see mail
  already in the inbox within the mailbox window; a job alert the owner
  deleted, archived out of the default view in a way `newer_than:` cannot
  reach, or that landed in Spam is invisible with no warning distinguishing
  that from "no new alerts."
- `bin/confirm.js` / `src/apply/mail-confirm.js` (apply pipeline slice 7, mail classifier and
  confirmation): the Gmail search query is a fixed keyword list (`subject:application`,
  `"thank you for applying"`, `"application status"`, etc.), not a sender allow-list, but it is still a
  blind spot of the same shape as `gmail`'s own alert-sender list above -- a confirmation/rejection mail
  whose subject and body match none of those keywords is invisible to the classifier with no warning; the
  unconditional 5-day nudge follow-up (`src/core/applications.js`'s `markSubmitted`/`markAppliedByHand`)
  is the deliberate mitigation, not a fix.
- `src/apply/mail-classifier.js`'s phrase library and company-extraction patterns were built and tested
  against constructed fixtures, never against a real inbox's actual rejection/confirmation wording (the
  Google refresh grant is currently `invalid_grant`, re-auth in progress separately -- there is no live
  Gmail access in this sandboxed environment). Real-world phrasing diversity beyond the patterns in that
  file (a rejection or confirmation that uses none of the matched clauses) classifies `unknown` and is
  silently skipped rather than mis-classified -- safe by construction, but it means real coverage is
  unverified until this runs against Damian's actual inbox.
- Company extraction is best-effort regex over the subject/body text (or, failing that, the From display
  name); an ATS whose confirmation/rejection template does not match any of the extraction patterns
  yields `company_raw: null`, which always falls out as `no_match` (never a wrong guess) -- but it does
  mean a real confirmation can go unmatched purely because the extraction pattern missed it, not because
  no candidate application existed.
- An HTML-only confirmation/rejection email is scanned via a tag-stripping pass (`stripTags`), not a real
  HTML parser -- the same limitation `src/apply/gmail-verify.js`'s own `extractVerification` already
  documents for the Workday verify-email flow; unusual markup (nested tables, hidden preheader text) can
  shift or duplicate words in ways the phrase/company regexes were not tested against.
- A withdrawn application still has an open 5-day nudge follow-up (creating it is unconditional on
  reaching `submitted`; nothing cancels it if the application is later withdrawn) -- a minor UX rough
  edge (a "check status" reminder for an application Damian already withdrew), not a correctness bug.
- `ic_gmail_processed_messages`' idempotency guarantee covers THIS job's own re-runs only; it has no
  awareness of the scan pipeline's or the dashboard's own event logs, so a message this job never saw at
  all (outside the `MAILBOX_WINDOW_DAYS` search window, or arriving after the window has rolled past) is
  not retried by anything -- again, the 5-day nudge is the backstop, not this table.
- The stored `description` column holds the lowercased hash-pipeline text, not
  the original case (stage 1 behavior, flagged, not changed).
- `render_doc` checks are lexical: tone, "supported" versus "drove" revenue
  framing, platform names in the summary, and the truth of a bullet stay with
  the model and the review skills.
- `noise_class`: `staffing_generic`'s "company's own careers host" check is a
  naive slug-vs-hostname heuristic (no real per-company domain mapping
  exists); `suspect`'s trigger words ("advisor", "equity") are common enough
  in legitimate titles that some ok rows will be flagged suspect with no
  further signal to disambiguate. The `staffingFirms` config list is a
  documented seed, not exhaustive; an unlisted staffing firm reads as `ok`.
- Title cleanup (`stripRepeatedLeadingSegment`): the floor is a single word
  only (scan-report-fixes item 2 narrowed it from "under 12 chars AND under 2
  words" to "under 2 words" -- a genuine short-title 2-word repeat like
  "Field CTO Field CTO" now collapses correctly). A real single-word
  coincidence ("CTO CTO Group", "Manager, Manager Development Program") is
  still deliberately left unmerged, with no signal distinguishing it from a
  genuine boilerplate repeat that happens to be one word -- there is no
  debug-level logging for this path (unlike the trailing-UI-fragment strip
  above, which does log its own strip events), so an unmerged single-word
  repeat is invisible unless someone notices it in a listing's title
  directly.
- R6 state/remote dedup: a live duplicate whose root listing later expires is
  out of scope (no re-promotion of a duplicate to root); a bare US state name
  with no comma/abbreviation ("just 'Texas'" vs. a city that happens to share
  a state's name, e.g. a town literally called Washington) carries the same
  inherent free-text-location ambiguity the rest of `normalizeLocation`
  already has.
- R4 detail-fetch ordering: a 'new'/'ambiguous' row queued for a detail fetch
  is NOT persisted until its source's whole detail pass runs (spec R4's
  "collect then sort"); two such rows that are true near-miss duplicates of
  EACH OTHER (not caught by the exact-key `seenKeys` check) arriving on
  different pages of the SAME source in the SAME run could both persist as
  separate rows instead of one deduping against the other, since neither is
  in the database yet when the other is classified. Rows that are NOT queued
  for a detail fetch (ineligible, or the adapter has no detail fetch) are
  unaffected and persist immediately as before.
- R1 report: "Look at these" and "Houston / Texas" only see rows whose
  `first_seen` falls in the window since the last report; a row that already
  existed and was merely updated (times_seen bumped, no new `first_seen`)
  never appears there even if its prescore or noise class changed materially
  on this run. The report's per-run "pages and details used against caps"
  view relies on each run's own stored `pages_by_source`; it does not
  separately reconcile against `ic_scan_budget`'s daily totals in the email
  itself (`scans({action:'status'})` remains the source of truth for that).
  The URL-safety check for report links is structural (domain + path
  pattern) only; unlike a live fetch's `urlguard`, it does not re-resolve DNS
  at report time.
