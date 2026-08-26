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
  config.lock.json    sha256 of the six scan config files; unattended runs refuse a mismatch
  sql/                001-008 migrations (each BEGIN/COMMIT, idempotent) + unique_indexes.sql (conditional)
  bin/                scan.js  migrate.js  backfill-embeddings.js  config-lock.js  remind.js
  src/server.js       MCP server (stdout carries JSON-RPC frames only)
  src/tools/          search_jobs query_jobs get_job mark_jobs profiles scans review render_doc
                      followups scan_report
  src/core/           config db logger errors normalize dedup upsert prescore noise compact embed
                      urlguard budget ratelimit scheduler scan-run google followups remind report render schema
  src/browser/        session (the only playwright import) capability extractors wall
  src/adapters/       index base greenhouse lever workday dayforce indeed linkedin exec-generic
  test/               node --test (fixtures under test/fixtures/)
  logs/               gitignored
  output/reports/     gitignored; daily scan-report markdown (YYYY-MM-DD-scan-report.md)
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
independent of the daily and per-query caps) with a slower per-request delay
(`delayMs` 2500-5500 ms, a 4000 ms base with +-1500 ms jitter) to reduce the
chance of a 429 mid-run.

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

Every listing gets a `noise_class` (recomputed on upsert and on `bin/migrate.js`'s
backfill): `ok`, `ok_manual`, `aggregator_repost`, `fractional_or_founder`,
`staffing_generic`, `unknown_source`, or `suspect`. The rule set is
config-locked (`config/noise-rules.json`, rules evaluated by an explicit
integer `priority`, never file position) and linted on every `config-lock`
run against named fixture cases in `config/noise-fixtures.json`, so a rule
edit that silently changes a known case fails closed. `prescore_raw` (the
original, unweighted score) is stored alongside `prescore` (the noise-class-
weighted score used for ranking and the detail-fetch gate); nothing is hidden
from `query_jobs` or the database by default (only the daily report's "Look
at these" section excludes non-`ok` rows, and it prints how many it excluded).

`normalizeTitle`/`normalizeListing` strip zero-width/format characters and a
duplicated leading boilerplate segment (LinkedIn's `"Field CTO\nField CTO
with..."` pattern) before tokenizing, cap the stored title at 200 chars, and
recognize a bare US state name or abbreviation ("Texas") as a location on its
own, distinct from a city. That last piece feeds a dedicated dedup rule:
identical company + title postings that are both remote or both a state-only
location (no city), posted within 14 days of each other, merge automatically
(never queued for review) -- the "same role broadcast once per state"
pattern. `bin/migrate.js` re-normalizes every existing listing's title/
location/hash and backfills this merge rule against the open review queue.

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

$a2 = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\remind.js" -WorkingDirectory $root
$t2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 07:00
Register-ScheduledTask -TaskName "job-search remind" -Action $a2 -Trigger $t2 -RunLevel Limited
```

`Get-ScheduledTaskInfo "job-search scan"` shows the last run time and result
code (`0`, `1`, `2` as above). Both scripts prune their own logs after 14 days.

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
rows first seen since the last report, excluding non-`ok` `noise_class` rows,
with a count of how many were excluded); "Houston / Texas" (same window,
filtered to the `exec-default` profile's home locations, any prescore); the
open review-queue count with its top 5 reasons; and currently disabled
sources. The email is plain text plus HTML; every listing field is
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

`node --test` from `mcp/job-search` runs every `test/*.test.js`. The DB-backed suites use marker profiles/companies (`zz-test-*`,
`ZZ-TEST-*`) and delete them afterwards; they run against the real `ic_context`
database. Two suites need files that are gitignored in this repo
(`data/project-index.md` for `render_doc.test.js`), so they only pass in a
checkout that has them.

`test/scenarios.test.js` covers the spec's end-to-end scenarios that need no
LinkedIn or Indeed: the same cross-source pair scanned three times yields
exactly two rows (root plus `duplicate_of`); a Python-inserted row that
duplicates a scanned URL is adopted at the next scan with one review-queue
entry and the run completes; a concurrent scan returns `locked` in under a
second; a closed CDP port yields `partial` plus `BROWSER_UNAVAILABLE`.
`test/adversary.test.js` holds the refusal cases for `classify()`, the URL
guard, wall classification, and the `render_doc` preflight.

`LIVE=1 node --test test/smoke-greenhouse.test.js` makes one real Greenhouse
boards-api call. Nothing else in the suite touches the network: fetch adapters
run over recorded fixtures (`test/fixtures/adapters/`) and browser adapters over
a fake capability. `test/har.test.js` records every request of a full fixture
run and asserts zero non-GET outside the Workday search POST and zero URLs
outside the registry patterns. `bin/scan.js` accepts
`JOBSEARCH_FIXTURE_MAP=<file.json>` (URL prefix to fixture file) so the CLI can
be exercised offline; `JOBSEARCH_CONFIG_LOCK` points the lock check at another
file for the same reason.

## Config lock

`node bin/config-lock.js` reports whether `config/*.json` matches
`config.lock.json` (exit 2 on mismatch). It also lints `config/noise-rules.json`
against the named fixture cases in `config/noise-fixtures.json` on every run
(check or `--write`), failing closed (exit 1) if any fixture's expected
`noise_class` no longer holds under the current rules -- this catches a
noise-rule edit that silently changes behavior for a known case, not just a
hash mismatch. After an intentional config edit run
`node bin/config-lock.js --write` and commit both.

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
  revoked grant shows up only as exit 1 on the next run, not as an alert. The
  desktop-app client secret sits in plaintext in that token file (an accepted,
  pre-existing exposure that `remind.js` now also depends on, and now
  `gmail.js` too).
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
- Title cleanup (`stripRepeatedLeadingSegment`): a genuine short-title repeat
  under 12 chars / 2 words (a real "CTO CTO" typo, as opposed to a
  boilerplate-plus-tagline repeat) is deliberately left unmerged and only
  logged at debug level, never routed to review.
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
