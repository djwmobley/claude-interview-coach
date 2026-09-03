# Auto-apply build spec (PR B)

Status: implemented (this PR). Records the decision-complete spec this build followed, so a later reader
does not have to re-derive interfaces from the diff alone.

## 1. Goal and non-goals

**Goal.** A daily unattended pipeline (`bin/auto-apply.js`, scheduled 06:55 via
`scripts/register-auto-apply-task.ps1`) that: (a) opportunistically resolves a scanned listing's REAL apply
target when it differs from the listing's own URL (LinkedIn/Indeed/exec-board/aggregator postings), (b)
selects a bounded number of listings per day that clear a fit floor, a US-only location gate, a
compensation floor, and an exact/allow-listed apply target, and (c) drives each selected candidate through
the existing one-click apply chain (resume draft -> independent review -> approve -> submit) without a
human clicking anything, while never exceeding a daily submission cap and never submitting through an
ambiguous or unresolved apply target.

**Non-goals.** No change to the one-click apply chain's own internals (`src/dashboard/resume-runner.js`,
`review-runner.js`, `src/core/applications.js`, `src/apply/worker.js`) beyond calling their existing
exported functions directly. No relaxation of `src/core/urlguard.js`'s registry (the probe registry in
`src/apply/probe-registry.js` is a separate, narrower guard, never a loosening of the scan/apply guard). No
change to `ATS_TYPES`, `TRANSITIONS`, or any existing migration. No new browser click automation for
"button-only Apply" affordances (documented blind spot, section 6) -- this PR observes the DOM for an
existing Apply anchor/button but never clicks one.

## 2. Schema (`sql/015_listing_apply_target.sql`)

Seven new columns on `ic_job_listings`: `apply_url`, `apply_ats`, `apply_ats_confidence`,
`apply_ats_hint` (jsonb), `apply_easy_only`, `apply_probed_at`, `probe_attempts` (default 0). See the
migration file's own header comment for the full rationale on each column. `apply_ats_hint` NEVER counts
as a resolved apply target on its own -- it is diagnostic only, captured from a same-tab query-param signal
a button-only Apply click could reveal (this PR never performs that click; the field exists so a future
click-capable prepare phase has somewhere to write it without another migration).

## 3. Config (`config/auto-apply.json`, `autoApplySchema` in `src/core/config.js`)

Extends the one-click apply PR A schema with:

| field | default | purpose |
|---|---|---|
| `probeCapPerSource` | 10 | max opportunistic persistence attempts per scan source per scan run (`src/core/scan-run.js`'s own counter) |
| `probeRowCap` | 3 | max additional listing rows `bin/auto-apply.js`'s prepare phase re-probes per run |
| `reprobeAfterHours` | 48 | cooldown before a still-unresolved listing is tried again |
| `lockMinutes` | 40 | `bin/auto-apply.js`'s own advisory-lock poll deadline |
| `pollSeconds` | 30 | poll interval while waiting for the lock |

## 4. Apply-target resolution

`src/apply/apply-target.js`:

- `decodeLinkedInSafetyGo(href)`: pure string decode of a `linkedin.com/safety/go/?url=<encoded>`
  interstitial to the real external URL it wraps. Never fetches or navigates.
- `INTERMEDIARY_HOSTS`: the closed list of job-board aggregators worth a redirect chase (Lensa, Jobot,
  ZipRecruiter, Glassdoor, talent.com, Adzuna, beBee, Jooble, WhatJobs). Anything else that is not already
  an exact target itself is left unresolved rather than chased -- chasing an arbitrary unknown host's
  redirects is exactly the risk `src/apply/probe-registry.js`'s host allow-list exists to prevent.
- `isExactTarget(classification, url)`: the single automation gate, `confidence === 'exact'` from
  `src/apply/ats-detect.js#classifyApplyUrl`, with one refinement -- a Workday tenant host additionally
  requires a `/job/` path segment (mirrors `src/adapters/workday.js`'s own scan-adapter convention),
  because `classifyApplyUrl`'s Workday regex is host-only and would otherwise call a bare tenant landing
  page "exact" too.
- `resolveApplyTarget(candidateHref, probeRegistry, opts)`: decode -> classify directly -> (if not already
  exact and the host is a known intermediary) redirect-chase via `resolveRedirects` -> classify the final
  URL. Total: every input maps to `{ resolved: true, url, ats, confidence: 'exact' }` or
  `{ resolved: false, reason, host? }`.

`src/apply/probe-registry.js`: a SEPARATE URL guard from `src/core/urlguard.js`, host-only (no
`pathPatterns` gate at all -- a probe only needs to know "is this host allowed", never "does this path
match the specific shape a scan/apply route is validated against"). Reuses `urlguard.js`'s own
`hostNameProblem`/`checkResolvedAddresses` for address classification rather than re-implementing it.
`buildProbeRegistryFromAtsApply` builds the production registry from `config/ats-apply.json`'s own ATS host
lists plus `INTERMEDIARY_HOSTS`.

## 5. Selection (`src/core/auto-apply-select.js`)

`isUsLocation(locationNorm)`: total classification over `src/core/normalize.js`'s real `location_norm`
vocabulary. `country-us`, any `state-*` value, any `remote-us*` value, and a bare `<slug>-<US state
abbreviation>` city form are US; everything else (including `country-de`, which is deliberately checked
BEFORE the generic city-form regex so Germany's ISO code never collides with Delaware's abbreviation) is
non-US.

`classifyCandidate(row, ctx)`: the closed, total reason enum, first-match-wins:

```
not_scored, below_fit, human_fit_override, duplicate_of, not_us, salary_below_floor,
active_application, no_description, apply_target_unresolved, easy_apply_only, ats_not_allowed,
confidence_not_exact, daily_cap, eligible
```

`below_fit` vs `human_fit_override`: a fit score under the floor that a human explicitly set (the newest
`ic_job_events` `kind='fit'` row for that listing has `actor <> 'auto'`) is reported distinctly from an
automatic model-driven exclusion, even though both exclude the candidate identically -- human-set fit
always wins over model fit (locked decision), and this distinction lets the daily report show WHICH kind
of exclusion happened.

`dedupResolvedTargets`: among rows already classified `eligible`, keeps only the first occurrence of each
distinct `(apply_ats, apply_url)` pair (rows are processed fit-score descending), so the same real posting
scanned via two different sources never gets applied to twice.

`daily_cap` accounting (`countAutoApprovedToday`): counts ONLY `ic_job_application_events` rows with
`kind='state'`, `to_state='approved'`, `actor='auto'`, since local midnight in `run.timezone` (default
America/Chicago; `startOfDayInTz` uses an `Intl`-based search, no timezone-arithmetic library, tests pin
`TZ=UTC`). `bin/auto-apply.js` calls `approve()` with `actor:'auto'` specifically so this count reflects
exactly what THIS pipeline advanced -- a review FAIL never reaches `approve()`, so it never consumes a
slot.

## 6. `bin/auto-apply.js`: prepare -> select -> apply

Lock: `pg_try_advisory_lock` on `src/core/scan-run.js`'s own `LOCK_KEY` (730193001), polled every
`pollSeconds` up to `lockMinutes` (exit 2 `LOCKED` if never acquired) -- held ONLY across the prepare phase
(the phase that would share the scan Chrome with an actual scan), then released before select/apply begin.
The final submission step calls `runApplyWorker()` directly (imported from `src/apply/worker.js`, never a
spawned copy of `bin/apply.js`), which acquires/releases this SAME lock itself, per application -- holding
the outer lock across the whole run would make every one of those calls report `LOCKED` against its own
caller's connection.

Apply chain per selected candidate, reusing the existing one-click apply exports directly (never copies):
`createApplication` (actor `'auto'`, preferring the resolved `apply_url`) -> `resumeRunner.run()` ->
`reviewRunner.run()` (VERDICT PASS required) -> `approve()` (actor `'auto'`) -> `runApplyWorker()`. Any
non-PASS or failed phase leaves the application wherever the chain stopped (`docs_ready` with
`review_verdict='FAIL'`, or `drafting` on a resume failure, etc.) and the run moves on to the next
candidate -- an unattended run never aborts on one candidate's failure (CLAUDE.md's "loud failure is not a
fix": warn and proceed on unattended paths).

`--dry-run`: the prepare phase makes zero writes (`persistApplyTargetForListing`'s own dry-run-first
check); select still runs read-only so the summary shows what would have been selected; the apply phase is
skipped entirely.

## 7. Opportunistic persistence during a normal scan (`src/core/apply-target-persist.js`)

`src/core/scan-run.js`'s `finalizeListing`/`tryFetchDetail` now capture whatever apply-target hint an
adapter's widened `fetchDetail` returned (`externalApplyUrl`/`easyApplyOnly`/`applyProbe` --
`src/adapters/base.js`'s `FetchDetailResult`) and persist it via the SAME `persistApplyTargetForListing`
function `bin/auto-apply.js`'s prepare phase uses, bounded by `probeCapPerSource` PER SOURCE PER SCAN RUN
(a `Map` in `executeRun`'s closure, mirroring `stats.pages_by_source`'s own per-source counting). This is
purely additive: a legacy adapter returning only `{ description }` produces no hint at all, so this path is
never reached and scan behavior is byte-for-byte unchanged for it.

Widened adapters (this PR): `greenhouse.js`, `workday.js`, `dayforce.js` (their own listing URL already IS
the apply page); `linkedin.js`, `indeed.js` (observe, never click, an existing Apply anchor/button via two
new `src/browser/extractors.js` functions, `linkedinApplyLink`/`indeedApplyState`); `exec-generic.js`
(cheerio-based anchor-text scan for an "Apply"-shaped link, real and testable without a browser since exec
boards' `fetch` mode already downloads raw HTML).

## 9. Button-only Apply hint capture (LinkedIn, GAP 1)

`isExactTarget` (section 4) was corrected to exclude `linkedin_easy`/`indeed_easy` explicitly: without
that fix, a bare LinkedIn listing URL would classify as `exact` on its own host (`ats-detect.js`'s
`classifyApplyUrl` is host-only for the `/jobs/view/` shape) and short-circuit resolution before this
feature ever ran -- `CLASSIFY_ONLY_ATS` in `src/apply/apply-target.js` is a deny-list of the two ATSs this
codebase already knows, by construction, can never be automated (`src/apply/worker.js`'s `classifyOnly`
gate), not a hand-picked subset of what auto-apply happens to support.

`src/apply/linkedin-button-probe.js` (pure, no browser dependency): `extractApplyHint(urlStr)` parses
`applicantTrackingSystemName`/`companyName` from a URL; `probeLinkedInButtonApply(page, session, opts)`
clicks a given selector EXACTLY ONCE, then polls (default 15 s, `pollIntervalMs` default 500 ms) for either
a new target opening (closed immediately after reading its URL) or the same tab's own URL gaining the hint
params. Tested against fully scripted fake page/session objects -- no real browser.

`src/apply/linkedin-button-prepare.js` (lives under `src/apply/`, not `src/core/`, because it constructs a
raw-Playwright click adapter -- `test/safety.test.js`'s structural safety lint forbids any `.click(` call
surface outside `src/apply/`) is the integration layer `bin/auto-apply.js`'s prepare phase calls
per LinkedIn candidate: navigates via the EXISTING safe, read-only Capability (`goto`/`readJson`, never a
new capability type) and calls the already-shipped `linkedinApplyLink` extractor to observe `{ href,
buttonOnly }`. An anchor href never reaches the click path at all. A `buttonOnly` result reserves one
`details` unit against `config/adapters.json`'s `linkedin.dailyDetails` (`src/core/budget.js`'s
`reserveBudget`, injectable for tests) before clicking -- budget exhaustion or no available browser session
skips the candidate entirely (no `probe_attempts` increment: no work was attempted). The click's outcome
(`new_target` / `hint` / `timeout`) becomes an `ApplyDetail` fed into the SAME
`persistApplyTargetForListing` the rest of prepare uses, so a hint or a timeout still records
`apply_probed_at`/`probe_attempts` without ever setting `apply_ats`.

`adaptPlaywrightPage` bridges a real Playwright `Page` (as returned by `src/browser/session.js`'s
`attachPage`) to the probe's minimal interface using `page.click()`/`page.url()`/`page.context().pages()`
directly -- never `src/apply/apply-capability.js`'s `makeApplyCapability` (that constructor has exactly one
callsite, `src/apply/worker.js`, enforced by `test/apply-lint.test.js`; this is not the apply pipeline's
submission path).

## 10. Daily digest wiring (GAP 2)

`src/core/auto-apply-state.js` mirrors `src/core/watchdog-state.js`'s own
`defaultWatchdogStateFile`/`readWatchdogState` pattern exactly: a single, stable
`<JOBSEARCH_LOG_DIR>/auto-apply-latest.json` file, overwritten on EVERY `bin/auto-apply.js` run (dry runs
included) regardless of whether `--json` was also passed, read with the same "any failure means no data,
never a thrown error" discipline as the watchdog state file.

`collectAutoApply`/`renderAutoApplyText`/`Html`/`Markdown` (`src/core/report.js`) now return a `{ hasRun:
false }` shape (and a corresponding "no auto-apply run recorded today" string) instead of `null` when no
summary is available -- the section is ALWAYS rendered into the digest body, never silently omitted,
distinct from `dashboardHealthLineText`'s own null-means-omit convention (a missing auto-apply run is the
normal, expected state most days, unlike a genuinely unhealthy dashboard). `src/core/remind.js#runRemind`
reads the summary file (I/O stays in remind.js, mirroring the watchdog state read; report.js stays pure)
and appends the three renderers' output into the plain-text, HTML, and markdown bodies alongside the
existing scan-report and follow-ups sections. `bin/remind.js` wires `autoApplySummaryFile` to
`defaultAutoApplySummaryFile(env.JOBSEARCH_LOG_DIR)` -- the exact path `bin/auto-apply.js` writes to.

## 11. Known deviations (deliberate, documented per review request)

- **Lock scope.** `bin/auto-apply.js` holds the shared `LOCK_KEY` advisory lock only across the "prepare"
  phase (poll/exit-2 exactly as specified), releasing it before select/apply run. Holding it through apply
  would deadlock every `runApplyWorker()` call inside the apply loop, which acquires the SAME lock
  per-application on its own connection -- see `runApplyWorker`'s own doc comment in `src/apply/worker.js`.
  This is unchanged from the original design and is not expected to change without a broader rework of how
  `runApplyWorker` acquires its lock.
- **`probeRowCap` semantics.** Implemented as a simple overall cap on how many additional listing rows
  `bin/auto-apply.js`'s prepare phase re-probes per run (`LIMIT $3` in `runPrepare`'s own candidate query),
  not a more elaborate "N beyond `probeCapPerSource`" formula -- the source text describing this field was
  ambiguous on the exact relationship between the per-run prepare cap and `scan-run.js`'s own per-source,
  per-scan-run `probeCapPerSource` counter, which remain two independent counters against two different
  code paths (prepare vs. opportunistic scan-time persistence).

## 12. Blind spots (what this PR's own tests cannot detect)

- **Live DOM.** `linkedinApplyLink`/`indeedApplyState` (`src/browser/extractors.js`) and the button/anchor
  selectors `src/apply/linkedin-button-probe.js` clicks run against `document`/`window.location`/a real
  Playwright `Page` in a real browser page; they are exercised here only through fake capability/page/
  session stubs that return canned values, never against a real LinkedIn/Indeed page's actual markup or a
  live click's real side effects (a real Easy Apply modal opening, a real new tab actually navigating).
  The CSS selectors are best-effort and unverified against a live, logged-in session.
- **The real one-click apply chain end to end.** `bin/auto-apply.js`'s `applyOneCandidate` is tested
  against fully scripted fakes for `resumeRunner`/`reviewRunner`/`runWorker`; it has never been run against
  a live `claude` CLI spawn or a real ATS submission.
- **Redirect chains against real intermediary sites.** `resolveRedirects`/`resolveApplyTarget` are tested
  against scripted fetch stubs; the actual redirect shapes Lensa/Jobot/ZipRecruiter/etc. use in production
  are unverified.
- **The scan-run.js integration's interaction with real scan traffic.** `maybeSaveApplyTarget` is wired
  into `finalizeListing`/`tryFetchDetail` and unit-tested via `persistApplyTargetForListing` directly and
  via the widened adapters' fake-ctx tests, but no test exercises a full `executeRun()` scan with a real
  adapter producing an `applyDetail` hint end to end.
- **The real `openLinkedInBrowser` wiring.** `bin/auto-apply.js`'s own connection to the scan Chrome
  session (`connectSession`, `session.attachPage`, `makeCapability`) for the button-probe path is
  exercised only by inspection, not by an automated test against a real or simulated CDP endpoint --
  `runPrepare`'s own tests inject `linkedInBrowser` directly, bypassing `openLinkedInBrowser` entirely.
