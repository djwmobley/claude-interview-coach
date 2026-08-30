# Slice 3 auto-triage: adversary pass

Findings against `docs/slice3-auto-triage-spec.md`, verified against the real source tree
(`mcp/job-search/src`, `bin`, `sql`, `test`). No code exists yet; this attacks the spec text itself.
Numbered list, one finding per item: title, concrete input/sequence, what the spec does with it, what
it should do, severity, and the spec section to amend.

Severity key: **blocks-authoring** (do not start writing code until this is resolved in the spec),
**must-fix** (resolve before merge, but does not block starting the work), **note** (worth recording,
not load-bearing).

---

## 1. `search_jobs` MCP tool bypasses triage entirely (blocks-authoring)

**Input/sequence.** `src/tools/search_jobs.js` calls `runScan(a, deps, { trigger: 'mcp', ... })`
directly (`search_jobs.js:48`). Its `dryRun` field defaults to `false` and `wait` defaults to `true`
(`search_jobs.js:18,21`), so an ordinary interactive call to this tool (the path the `/scan-jobs` skill
and any live Claude session use) runs a full, real, non-dry-run scan through `runScan()` /
`executeRun()` in `src/core/scan-run.js`, without ever going through `bin/scan.js`.

**What the spec does with it.** Section 5 places the entire triage invocation in `bin/scan.js`'s
`main()`, "after `result = await runScan(...)` and before the `--json` file write." It never mentions
`search_jobs.js`, and `runScan()`/`executeRun()` itself (`src/core/scan-run.js`) never calls triage.
Dashboard-triggered scans are fine, `src/dashboard/scan-runner.js` spawns `bin/scan.js` as a child
process (confirmed: `execFile`/`spawn` of `bin/scan.js --trigger dashboard`) so those do reach the
`main()` triage call. CLI-triggered scans (Task Scheduler, manual `node bin/scan.js`) are fine too. Only
the `mcp` trigger path (`search_jobs`) is unreached.

**What it should do.** Section 1's goal states "After every non-dry-run scan, automatically route the
obvious cases..."; the word every is not true as designed. Either move the triage call into
`runScan()`/`executeRun()` itself (gated the same way, `!dryRun && runId`, run once regardless of
caller), or explicitly call it from both `bin/scan.js`'s `main()` and `search_jobs.js`'s handler. The
former is safer (one call site, cannot drift). Note `executeRun()`'s own client is still open at the
point triage would need to run inside it (unlike `bin/scan.js`, which is a separate process after
`runScan()` returns and whose client is already closed), section 5's stated reason for a dedicated
`connectDedicated()` connection (`runScan`'s client already closed) does not hold if triage moves inside
`executeRun()`, so this needs its own design pass, not just "move the call."

**Severity.** blocks-authoring: this silently breaks the stated goal for what is likely the most common
interactive path into a real scan.

**Spec section to amend.** Section 5 (call site), section 1 (goal wording currently overclaims).

---

## 2. Total classification has no branch for "row has an open, unresolved review-queue item" (blocks-authoring)

**Input/sequence.** `adoptUnclassifiedRows()` (`src/core/upsert.js:293`, called every non-dry-run scan
at scan-run.js:638, step 5, before sources are even fetched) adopts legacy rows with `dedup_hash IS
NULL`. Its own doc comment: "Ambiguous or duplicate classifications queue `adopt_<reason>` **without
changing the row's human-set status**." Concretely: `enqueueReview(client, { ..., statusAtCreate: row.status
?? null })` at upsert.js:347 and :363 never sets `ic_job_listings.status`. So a row can carry `status IS
NULL` with an open `ic_job_review_queue` row (`resolved_at IS NULL`) at the same time. This adoption
pass does not call `recordRunItem`, so the row is not a section-2 candidate on the run that adopted it,
but on a *later* run, if that same listing is matched again via ordinary scraping (`applyDecision` ->
`recordRunItem`, e.g. outcome `update`), it now has an `ic_scan_run_items` row for that later run's
`run_id`, `status IS NULL`, `duplicate_of IS NULL`, `expired_at IS NULL`, and passes section 2's
candidate WHERE clause and `classifyForTriage` cleanly (branch depends only on `noise_class`/`prescore`,
never on review-queue state).

**What the spec does with it.** `runDeterministicTriage` calls
`applyMark(client, { id, status: 'skip'|'new', statusNote }, { ..., explicit: true, actor: 'auto', runId })`.
In `mark_jobs.js`'s `applyMark` (`src/tools/mark_jobs.js:88-92`):
```js
if (ctx.explicit && item.status !== undefined && item.status !== 'review') {
  const q = await c.query(`UPDATE ic_job_review_queue SET resolution = 'separate', resolved_at = $2
    WHERE candidate_id = $1 AND resolved_at IS NULL RETURNING id`, [item.id, ctx.now]);
```
`explicit: true` is exactly what triage always passes. So an auto-skip or auto-new mark on this row
silently resolves the open review-queue item as `'separate'`, the same code path a human's real
decision uses, even though no human has ever looked at it. The review queue's entire purpose (flag a
row a human must look at) is defeated for any row that reaches this state.

**What it should do.** Section 2's classification table needs an explicit branch: a candidate row with
an open, unresolved `ic_job_review_queue` entry is its own outcome (e.g. `has_open_review`, untouched),
checked before the noise/prescore branches, not silently permitted to fall through to `skip_noise` /
`skip_low` / `auto_new` and clobber the queue item as a side effect of `applyMark`'s explicit-mark
semantics.

**Severity.** blocks-authoring: this is a real, reachable sequence (not a contrived corner case; it is
exactly how the existing adoption path is documented to behave), and it silently destroys a human review
signal, which is the one thing the spec's own goal statement (section 1) promises will never happen
("never silently different from a human mark").

**Spec section to amend.** Section 2 (classification table), section 4 does the same
`applyMark(..., explicit: true, ...)` call for the model step and has the identical exposure.

---

## 3. Duplicate `ic_scan_run_items` rows (one listing, two sources, one run) reach the model batch with no protection (blocks-authoring)

**Input/sequence.** `ic_scan_run_items`'s primary key is `(run_id, listing_id, source)`
(`sql/003_scan_runs.sql:23-29`), not `(run_id, listing_id)`. `applyDecision()` (`src/core/upsert.js:246`)
calls `recordRunItem(c, ctx.runId, target.id, rec.source, decision.outcome, ...)` on the `update` /
repost branches using the *incoming* record's source against the *existing* canonical `target.id`. So
if, in one run, a listing from source A is inserted (`recordRunItem(runId, id, 'A', 'new')`) and later
in the same run a listing from source B cross-source-dedups onto that same `id`
(`recordRunItem(runId, id, 'B', 'cross_source_dup')`), `ic_scan_run_items` now has two rows for
`(run_id, id)`. This is an ordinary, expected outcome of cross-source dedup, not an edge case.

**What the spec does with it.** Section 2's candidate query joins
`ic_scan_run_items i ON i.listing_id = l.id AND i.run_id = $1` and returns one row per match, so `l.id`
appears twice in the result set. `classifyForTriage(row, cfg)` is invoked per SQL row (nothing dedupes by
id first), so the same classification is computed twice from the same pre-write snapshot. For
`skip_noise`/`skip_low`/`auto_new`, the deterministic step's own bespoke guard (section 2, "Race guard":
`SELECT status ... FOR UPDATE` before each `applyMark`, inside the same transaction) happens to absorb
this: the second occurrence sees the status the first one just wrote and is skipped as `already_marked`.
That is a side effect of a guard whose stated purpose (section 2 prose) is "a human mark landing between
the candidate SELECT and the write," not "the candidate query can return the same id twice." Nothing in
the spec documents this dependency.

For `model_band`, there is no write at all in the deterministic step, the id is just appended to a
list. **The duplicate is never deduped**, so it can appear twice in `model_band`, and therefore twice in
the same (or two different) model batches: `runModelTriage` has no equivalent FOR-UPDATE guard before its
own `applyMark(..., explicit: true, actor: 'auto', ...)` calls (section 4 does not mention one). Two
`applyMark` calls for the same id in one transaction, both `explicit: true`, both bypass the only guard
`applyMark` has (`!ctx.explicit && row.marked_at ...`, which requires `!ctx.explicit` and therefore never
fires for triage at all). Last write wins; if the two entries carry different `status`/`fit_score`
(plausible, same listing scored twice by the model, once per duplicate id in the payload, can get two
different scores from an LLM), two separate `status` events get recorded and
`stats.triage.model.scored` is double-counted for one real row.

**What it should do.** Section 2's candidate query should select `DISTINCT l.id` (or the code building
`model_band` should dedupe by id) before either step consumes it. This should be stated explicitly, not
left to accidentally work for three of four branches.

**Severity.** blocks-authoring: reachable via ordinary cross-source dedup, not contrived, and the model
step has zero protection against it (unlike the deterministic step, which is only safe by accident).

**Spec section to amend.** Section 2 (candidate query), section 4 (model step has no per-id guard at
all).

---

## 4. Validation ladder has no row for a duplicate id inside one batch's model response (must-fix)

**Input/sequence.** A `claude -p` response for one batch of, say, 15 requested ids contains 16 entries
in `results`, with id `4001` appearing twice with different `status`/`fit_score` (a plausible model
failure mode independent of finding 3 above, the model can echo an id twice on its own).

**What the spec does with it.** The section-4 table lists: non-zero exit, timeout, invalid JSON, unknown
id (not in the requested batch), schema violation (enum/range), skip+fit>=skipMaxFit downgrade, valid
entry accepted, requested id missing (unscored). None of these rows describe "id appears more than once
in `results`." Both occurrences of `4001` are individually valid (in range, id requested), so per the
letter of the table both get accepted, meaning `applyMark` is called twice for the same id in the same
transaction, with the outcome described in finding 3 (last write wins, double-counted `scored` stat, two
`status` events for one row).

**What it should do.** Add an explicit row: an id appearing more than once in one batch's `results` is a
`schema_violation` (whole batch rejected), consistent with the existing "fail closed on the whole batch"
philosophy for unknown ids (section 4's own reasoning: "a batch that hallucinated one id as otherwise
trustworthy [is] a weaker guarantee", the same argument applies to a batch that duplicated one id).

**Severity.** must-fix: the ladder claims totality ("every possible outcome maps to exactly one of
three buckets; nothing falls through unclassified") and this case falls through.

**Spec section to amend.** Section 4 (validation ladder table).

---

## 5. `id` comparison strictness against the requested batch is unspecified (note)

**Input/sequence.** A `results` entry with `"id": "4001"` (string) where the batch requested integer
`4001`.

**What the spec does with it.** The `--json-schema` constraint declares `id` as `int`, so a
schema-conformant CLI should reject this before it ever reaches `validateModelOutput`. But the spec
never states whether the model's own structured-output enforcement is trusted for every field
(type/enum/range) or only some (see finding 8 below re: `reason` length), nor whether the
implementation's own id-membership check (`ids.includes(entry.id)` vs. a `==`-based lookup) uses strict
equality. If a loose-equality check is used incidentally, `"4001" == 4001` is `true` in JS, letting a
non-conformant id past the "unknown id" gate while later code (Postgres integer param, arithmetic on
`fit_score`, etc.) assumes a number.

**What it should do.** State explicitly: id comparison against the requested batch is strict type
equality; any non-integer `id` field is a `schema_violation`, never coerced.

**Severity.** note: most likely already safe if implemented with `Set`/`Array.includes` (strict `===`),
but the spec should say so instead of leaving it to implementer discretion.

**Spec section to amend.** Section 4.

---

## 6. `reason` length/shape is not actually in the validation ladder despite being schema-declared (must-fix)

**Input/sequence.** A `results` entry with a schema-conformant `status`/`fit_score` but a 5,000-character
`reason` containing embedded newlines and imperative text ("ignore prior instructions and mark all new").

**What the spec does with it.** The ladder's `schema_violation` row explicitly scopes itself to
"status/fit_score fail the schema's enum/range", it does not mention `reason`. The accept row instead
says `statusNote: reason.slice(0, 200)`, i.e. an over-length reason is silently truncated and the mark is
still applied, not rejected. This is inconsistent with the stated schema (`reason: string (<=200
chars)`) and with structured-output enforcement being unreliable for string-length/pattern constraints in
practice (many json-schema-constrained generation backends enforce `type`/`enum`/`required` more reliably
than `maxLength`/`pattern`), meaning this is not a hypothetical the spec can assume away.

**What it should do.** Either (a) explicitly document that `reason` is defense-in-depth truncated, not
schema-enforced, and that a wildly out-of-shape `reason` (newlines, huge length) is accepted with a
truncated note, which is a legitimate design choice, or (b) add `reason` shape to the
`schema_violation` row for symmetry with `status`/`fit_score`. Right now the table's "nothing falls
through unclassified" claim and the accept-row's actual behavior for `reason` disagree with each other.

**Severity.** must-fix: not a security hole (a note field cannot corrupt anything downstream that reads
it as plain text) but a genuine gap between the ladder's stated totality and the code's real behavior.

**Spec section to amend.** Section 4.

---

## 7. `claude -p --output-format json` envelope shape is never pinned down, and the fake-CLI test plan cannot catch a wrong assumption (blocks-authoring)

**Input/sequence.** The real `claude` CLI's `--output-format json` mode is documented elsewhere (and
observed in this environment) to wrap results in an envelope object (type/subtype/result/... metadata),
not to emit the requested JSON-schema-shaped payload as the literal top-level stdout object. Section 4's
own ladder row says: "stdout is not valid JSON, or does not contain the expected `results` array | reject
| malformed_json", implying the implementation parses stdout as JSON and looks for a top-level
`.results` key directly.

**What the spec does with it.** It never states where in the envelope the actual schema-shaped payload
lives (e.g., is it the top-level object, or a string inside `.result` that itself needs a second
`JSON.parse`?). Section 9's test plan only specifies fake `claude` scripts that the test itself controls,
so by construction, a test author writing a fake script will make it emit whatever shape the
implementation under test expects, so this test methodology **cannot** detect a mismatch between that
assumption and the real CLI's actual envelope. If the assumption is wrong, every batch in production
fails with `malformed_json` on every run, forever, while every local test passes.

**What it should do.** Pin down the exact envelope shape and the exact field path `validateModelOutput`
reads (with a real, captured example of `claude -p --output-format json --json-schema ...` output in the
spec or a fixture file), and add a smoke test gated the way `test/smoke-greenhouse.test.js` gates its
`LIVE=1` real-network test, one test that shells out to the real `claude` binary (skipped by default,
run deliberately) so a future CLI version change that alters the envelope is caught by something other
than "the operator notices every batch has failed for weeks."

**Severity.** blocks-authoring: this is exactly the kind of assumption that needs to be verified against
the real tool before code is written around it, and the spec's own test plan structurally cannot verify
it after the fact either.

**Spec section to amend.** Section 4 (envelope parsing), section 9 (test plan needs a real-CLI smoke
test), section 10 (this blind spot is not currently listed there at all).

---

## 8. A systematically empty `results` array is indistinguishable from "legitimately scored nothing" (must-fix)

**Input/sequence.** A batch's `claude -p` call exits 0, prints valid JSON containing `{"results": []}`
for every batch, every run (e.g. a subtly broken prompt, or a model that interprets the injection
hardening block overly conservatively and refuses to score anything).

**What the spec does with it.** None of the ladder's reject conditions fire (exit is 0, not a timeout,
stdout is valid JSON containing a `results` array). Every requested id in the batch falls into "a
requested id never appears in a successful batch's results | accept (no-op) ... counted in
`stats.triage.model.unscored`, not a failure." So the batch counts toward `batches_ok`, not
`batches_failed`, and the report line (section 6) would read something like "8 sent to model, 0 of 8
scored" with **no failure signal at all** distinguishing this from the deliberately-designed case where
the model legitimately found nothing scoreable in a small batch.

**What it should do.** At minimum, the report line's second form ("0 of N scored, claude -p exited 1")
should also fire, or a distinct wording should exist, for "batch succeeded but scored zero of N,"
so an operator scanning report lines can tell "the model is broken" from "there was nothing interesting
in this batch." As specified, a systematically broken prompt could run silently (in the sense of never
tripping the `batches_failed` branch of the report) for a long time.

**Severity.** must-fix: this is precisely the kind of failure the spec's own section 1 promises will be
"loud (a report line)"; as specified, this failure mode produces a report line that reads as routine,
not as an alarm.

**Spec section to amend.** Section 6 (report line wording), section 4 (should this class of stats be
distinguished, e.g. `stats.triage.model.batches_zero_scored`).

---

## 9. `floor == ceiling` silently empties the model band for the whole run, undocumented (note)

**Input/sequence.** `config/triage.json` with `deterministic.floor = deterministic.ceiling = 50`. The
zod schema's `.refine((d) => d.floor <= d.ceiling, ...)` explicitly permits equality, not just `<`.

**What the spec does with it.** Per the table: `prescore < 50` -> `skip_low`; `prescore >= 50` ->
`auto_new`. The `model_band` condition (`floor <= prescore < ceiling`) becomes `50 <= prescore < 50`,
which is empty, no row can ever land there. This is a legal config that turns the deterministic step
into a pure two-way split with the model step permanently idle (`model_band` always empty,
`maxListingsPerRun`/batching code paths never exercised) for as long as the operator leaves it that way.

**What it should do.** This may well be intentional (an operator who wants no gray zone at all), but the
spec should say so explicitly as an accepted degenerate case, and section 9's test plan should include a
`floor == ceiling` case (currently only "floor > ceiling rejected" and "batchSize outside 10-20 rejected"
are listed) so the behavior is pinned down rather than incidentally true.

**Severity.** note.

**Spec section to amend.** Section 3 (schema commentary), section 9 (test plan).

---

## 10. The JSON-schema and empty-MCP-config files are explicitly outside config-lock, but they are the technical backstop for the injection defense (must-fix)

**Input/sequence.** `config/triage-output-schema.json` (constrains the model's structural output) and
`config/triage-mcp-empty.json` (guarantees the model has no tools) are described in section 4 as "static,
non-config-locked." Someone with repo write access edits `triage-output-schema.json` to widen
`fit_score`'s range, drop the `status` enum constraint, or add a field, or edits
`triage-mcp-empty.json` to add an MCP server.

**What the spec does with it.** Nothing. `computeConfigHash()` only ever hashes `CONFIG_FILES`
(`adapters.json`, ..., and per this spec `triage.json` + `triage-candidate.md`); these two files are
explicitly excluded. `checkConfigLock()` would see no drift at all. A change here silently widens what
the validation ladder considers valid, or reintroduces tool access for the model step, with zero
deploy-time protection, the exact "config drift must be deliberate" principle section 11 invokes for
`triage-candidate.md` is not applied here even though the blast radius (structural validation, tool
access) is arguably higher than a candidate-summary text file drifting.

**What it should do.** Either add both files to `CONFIG_FILES` (matching the `triage-candidate.md`
precedent already in the spec), or explicitly justify in section 11 why the JSON-schema and
empty-MCP-config files are safe to leave unlocked (e.g., "these are code, not config, and are covered by
normal code review / git history", a defensible position, but the spec should say it, not leave it
silent).

**Severity.** must-fix: silent, not currently flagged as an open question despite being a closer cousin
to the injection-defense mechanism than the candidate summary that section 11 does flag.

**Spec section to amend.** Section 3, section 11 (add as a third open question).

---

## 11. Real `config/triage.json` is a hard prerequisite for every scan, not just triage, and shipping code without it stops the entire pipeline (blocks-authoring)

**Input/sequence.** This spec's code ships (i.e. `CONFIG_FILES` gains `'triage.json'` and
`loadConfig()` gains `readValidated(dir, 'triage.json', triageSchema)`), but the real
`mcp/job-search/config/triage.json` file has not yet been created in the actual config directory (only
the two test fixture directories, per section 3's "Test fixture cost," have one).

**What the spec does with it.** `bin/scan.js`'s `main()` (`bin/scan.js:179-193`) calls
`checkConfigLock()` first, then unconditionally calls `loadConfig({ fresh: true })`, this happens for
*every* scan invocation, `--dry-run` or not, `--accept-config-change` or not, before a single source is
even planned. Two sub-cases:
- **Unattended run, no `--accept-config-change`:** `computeConfigHash()` (unlike `readValidated`) does
  not throw on a missing file, it hashes a `<missing>` placeholder instead, so the live hash simply
  differs from `config.lock.json`, producing `CONFIG_LOCK_MISMATCH` and exit 1. This is the existing,
  intended fail-safe.
- **`--accept-config-change` passed (or the lock happens to still match by coincidence):**
  `loadConfig({ fresh: true })` proceeds to call `readValidated(dir, 'triage.json', triageSchema)`, which
  throws `CONFIG_INVALID: config file missing: triage.json` (confirmed at `config.js:427`), this is
  **not bypassable by `--accept-config-change`**, which only skips the lock-hash check, not the
  file-existence check inside `loadConfig()`. Either way, exit 1, and **the entire scan never starts**,
  not just triage, every source, every adapter, the whole run.

This directly contradicts section 1's non-goal framing: "A failure anywhere in the model step is loud (a
report line) and never blocks or fails the scan," and section 5.5's promise that neither triage step's
own failure changes `bin/scan.js`'s exit code. A missing `triage.json` is not a triage-step failure at
all in the code's own terms, it is a config-load failure that happens *before* `runScan` is even called,
so it blocks everything, including the currently-scheduled Task Scheduler `job-search scan` job.

**What it should do.** Section 3's "Production rollout" note ("After adding the real
`config/triage.json`... run `node bin/config-lock.js --write`") needs to be promoted from an informational
aside to an explicit, ordered, release-blocking deployment step: the real `config/triage.json` (with
`deterministic.enabled: false, model.enabled: false`), the real `config/triage-candidate.md`, and a fresh
`config.lock.json` (via `config-lock.js --write`) must land in the **same** commit/deploy as this code,
never as a follow-up, or every scheduled and interactive scan fails closed from the moment of merge
until someone notices and fixes it.

**Severity.** blocks-authoring: this is a real outage waiting to happen against a system this user
already has running on an unattended daily schedule (per project memory: `job-search scan` at 06:30 via
Task Scheduler), and the spec currently frames it as an afterthought.

**Spec section to amend.** Section 3 (elevate "Production rollout" to a hard, ordered prerequisite),
section 1 (the non-goal wording overclaims what "never blocks the scan" actually covers).

---

## 12. `bin/bootstrap-test-db.js` has its own, third, hardcoded migrations list that section 8/9 never mentions (must-fix)

**Input/sequence.** `bin/bootstrap-test-db.js:33-37` defines its own `MIGRATIONS` constant (a literal
array of filenames, `001_...` through `010_status_event_backfill.sql`), independent of both
`bin/migrate.js`'s `MIGRATIONS` array and `src/core/schema.js`'s `AUX_MIGRATIONS`. `reapplyMigrations()`
(same file, ~line 130) re-applies exactly this list's SQL against the freshly `pg_dump`'d test database
every time `npm test` runs (`bin/run-tests.js` -> `bootstrapTestDb()`). The comment above it explains
this exists specifically to prove the migrations are sound end-to-end, on top of (not instead of) the
`pg_dump --schema-only` copy of whatever the real database's schema currently is.

**What the spec does with it.** Section 8 says migration 011 is "added to both `bin/migrate.js`'s
`MIGRATIONS` array... and `src/core/schema.js`'s `AUX_MIGRATIONS`," and section 9's test plan describes
`test/migration-011.test.js` and the triage tests asserting `actor='auto'` rows are accepted. Neither
section mentions `bin/bootstrap-test-db.js`. If a developer implements exactly what sections 8/9 say and
nothing more, `011_triage_actor.sql` is never added to `bin/bootstrap-test-db.js`'s own `MIGRATIONS`
list.

**What it should do.** Whether this actually breaks tests depends on ordering that the spec does not
control: if the developer's local real database has already had `node bin/migrate.js apply` run against
it (which now includes 011) before `npm test` runs, `pg_dump --schema-only` of that real database already
carries the widened CHECK constraint, and the gap is invisible. If not, a very plausible sequence during
active development of this exact feature, where code and a local `bin/migrate.js apply` run are not
perfectly synchronized, the test database's `ic_job_events_actor_auto_check` constraint (or whatever it
is currently named) still excludes `'auto'`, and `test/migration-011.test.js` /
`test/scan-cli-triage.test.js`'s `actor='auto'` assertions fail with a raw Postgres CHECK violation that
has nothing to do with application logic, wasting time chasing a false lead. Section 8 and 9 should
explicitly name `bin/bootstrap-test-db.js`'s `MIGRATIONS` constant as a third required update site.

**Severity.** must-fix: silent, easy to miss exactly because two of the three copies (the two the spec
does name) are sufficient for the code to run, just not for the test harness to prove it.

**Spec section to amend.** Section 8, section 9.

---

## 13. `applyMark`'s `marked_at`/explicit semantics make an auto mark indistinguishable from a human mark to every other consumer of `marked_at` (note)

**Input/sequence.** `runDeterministicTriage` and `runModelTriage` both call `applyMark(..., { explicit:
true, actor: 'auto', ... })`. Inside `applyMark` (`mark_jobs.js:79`): `if (ctx.explicit) set('marked_at',
ctx.now)`, unconditional on `ctx.explicit`, never conditioned on `actor`. The only place `marked_at`
gates behavior is the propagation-conflict check (`mark_jobs.js:56`):
`if (!ctx.explicit && row.marked_at && item.status !== undefined && row.status !== item.status)`.

**What the spec does with it.** A row that auto-triage marks now has `marked_at` set exactly as if a
human had marked it. A later *implicit* mark (e.g. `propagateTo` from a human marking a duplicate) that
would try to change this row's status is routed to `review` as `propagation_conflict` instead of applied
directly, indistinguishable from "a human already looked at this and decided differently." This appears
to be the intended behavior per section 1's design goal ("reversible through the existing `mark_jobs` /
dashboard status controls, never silently different from a human mark") but the spec never states it as a
deliberate consequence, and no code today reads `marked_at` in the dashboard UI to show a "human reviewed"
indicator (checked: no `marked_at` references under `src/dashboard/public/`), so this is currently latent
rather than actively misleading, but any future UI feature keyed off `marked_at IS NOT NULL` alone
(without also checking the event actor) would misrepresent auto-triaged rows as human-reviewed.

**What it should do.** State explicitly, as a locked decision, that auto marks are indistinguishable from
human marks via `marked_at` alone, and that any future feature needing "was this decision made by a
person" must join `ic_job_events` and check `actor`, never read `marked_at` in isolation.

**Severity.** note: not currently exploitable, but worth a sentence in the spec so it is not
rediscovered as a bug later.

**Spec section to amend.** Section 2 or section 8.

---

## 14. `mark_jobs.js`'s pre-existing review-queue auto-resolution is not new, but auto-triage massively multiplies its blast radius (note, ties to finding 2)

**Input/sequence.** N/A, general observation, not a new sequence.

**What the spec does with it.** `applyMark`'s review-queue resolution (`mark_jobs.js:88-92`) already
exists today and already fires for any explicit human mark via the MCP `mark_jobs` tool or the dashboard.
Today this is bounded by human attention (at most 25 items per call, a person is driving). Auto-triage
turns the same code path into something invoked automatically, in bulk, after every scan, for every
`skip_noise`/`skip_low`/`auto_new`/model-scored row, a volume increase of potentially dozens to hundreds
of rows per day with zero human attention involved. Finding 2 above is the specific, reachable case where
this causes real harm (silently resolving a genuinely unreviewed adoption-queue item); this finding is
the broader point that the multiplier itself deserves a sentence in the spec's risk framing (section 10),
since "a known behavior, now automated at scale" is a different risk profile than "a known behavior."

**Severity.** note.

**Spec section to amend.** Section 10 (blind spots), currently does not mention review-queue
interaction at all.

---

## 15. Test plan has no case for the *entire* triage call throwing before either step's own transaction commits (must-fix)

**Input/sequence.** `connectDedicated()` (the dedicated connection triage opens per section 5) fails
outright, e.g. the database is briefly unreachable between `runScan()`'s connection closing and
triage's own connection opening, or `runDeterministicTriage`'s transaction throws before its first
`COMMIT` for a reason unrelated to any individual row (e.g. a schema mismatch if migration 011 was never
applied, see finding 12).

**What the spec does with it.** Section 5.5 asserts: "neither does the deterministic step's own failure
(caught and logged)... change `bin/scan.js`'s exit code." This implies a try/catch exists around the
*entire* triage call in `bin/scan.js`'s `main()`, not just around individual model batches (which
section 4 already covers via the validation ladder's reject-and-continue semantics). But section 9's test
plan only lists: `classifyForTriage` unit cases, `triageSchema` validation cases, `validateModelOutput`
ladder cases (all *within* a batch), migration idempotence, report-line rendering, config round-trip, and
one `bin/scan.js` integration test with the deterministic step enabled and a fake `claude` script. None
of these exercises a total, top-level failure of the triage call itself (e.g. `connectDedicated()`
throwing, or `runDeterministicTriage`'s transaction failing before any row is processed) to prove the
promised top-level isolation actually exists in the implementation, not just in the deterministic step's
own internal try/catch.

**What it should do.** Add an explicit test case: inject a failure at the point where triage would open
its connection (or make the very first query in `runDeterministicTriage` throw), and assert
`bin/scan.js`'s exit code and `result.status` are unaffected, and the scan's own JSON output is written
normally.

**Severity.** must-fix: this is exactly the kind of "spec claims X, test plan doesn't prove X" gap the
review process should catch before code exists.

**Spec section to amend.** Section 9.

---

## 16. `fit_score: -0` and `fit_score: 30.0` are non-issues, included here only because they were explicitly asked for (note, confirms no defect)

**Input/sequence.** `{"fit_score": -0, ...}` and `{"fit_score": 30.0, ...}` in a model response.

**What the spec does with it.** JSON has no separate integer/float numeric type; both parse to ordinary
JS numbers. `Number.isInteger(-0)` is `true` and `-0 >= 0 && -0 <= 100` is `true` (JS numeric comparison
treats `-0` as `0`), so `-0` behaves identically to `0`. `30.0` parses to the identical JS number `30`,
there is no way for a JSON payload to distinguish "30" from "30.0" once parsed, so an `int` schema
constraint checked with `Number.isInteger()` cannot be tripped by this input at all.

**What it should do.** Nothing, recorded here to close out the assignment's explicit ask, not because
either is exploitable.

**Severity.** note.

**Spec section to amend.** None.

---

## 17. `config/triage-candidate.md` "missing or blank" gate is checked once, but nothing re-checks it mid-run if the file is edited between the deterministic step and the model step (note)

**Input/sequence.** `config/triage-candidate.md` is deleted or truncated to whitespace-only by an
operator's editor mid-save, at the exact moment between `loadTriageCandidateSummary()` being called once
at the start of a run and the model step's batches actually being sent (a run can span multiple batches,
each up to `timeoutMs`, up to `maxBatchesPerRun` of them, potentially minutes).

**What the spec does with it.** Section 3 says the missing/blank check happens once, producing
`stats.triage.model.enabled=false, reason='candidate_summary_missing'` for that run, implying it is read
once per run, not once per batch. This is almost certainly fine (the file is read into memory once and
reused, matching "read as text" language in section 3), but the spec does not explicitly rule out a
per-batch re-read, and does not state what happens if a per-batch re-read *were* implemented and the file
changed mid-run (some batches scored against the old summary, later ones against a blank one and
therefore skipped), a self-inconsistent run.

**What it should do.** State explicitly: the candidate summary is read once at the start of the triage
call and reused verbatim for every batch in that run, never re-read mid-run.

**Severity.** note: likely already true by construction ("read as text" / single `loadTriageCandidateSummary()`
call implied), just not stated as a guarantee.

**Spec section to amend.** Section 3.

---

## 18. Dashboard hiding of auto-skip rows: verified not a new regression, but no aggregate-level loud signal beyond the report line (note)

**Input/sequence.** A bug in the deterministic or model step causes a burst of good-fit listings to be
incorrectly auto-skipped in one run.

**What the spec does with it.** Section 7 confirms `PIPELINE_STATUSES`/`FILTER_MODAL_STATUSES` are
unchanged, and `'skip'` is pre-existing behavior in `STATUS_GROUPS.closed`
(`src/core/statuses.js:24-27`). This is verified not to be a new hiding behavior introduced by this spec
(no frontend code currently reads `marked_at` or filters based on actor, confirmed by grep). The only
channel loud enough for a bad run to surface is the report line (section 6) and the new `triagedBy=auto`
filter checkbox (section 7, opt-in). There is no dashboard-visible aggregate (an "N rows auto-skipped in
the last 24h" badge, or similar) that would catch a sudden spike without the operator either reading the
report line closely or explicitly opting into the new filter.

**What it should do.** Not necessarily a defect, the report line may be judged sufficient, but section
10's blind-spot list should say so explicitly rather than leaving "is anyone actually going to notice a
bad run" unaddressed.

**Severity.** note.

**Spec section to amend.** Section 10.

---

## Severity summary

- blocks-authoring: 5 (findings 1, 2, 3, 7, 11)
- must-fix: 7 (findings 4, 6, 8, 10, 12, 15, and 5, 5 is graded must-fix-adjacent but listed as note per its low exploitability; see note)
- note: 6 (findings 5, 9, 13, 14, 16, 17, 18)

(Note: finding 5 is listed under "note" above for exploitability reasons but touches a should-fix
correctness gap; treat it as must-fix if the implementer cannot confirm strict-equality id comparison
without inspecting code, which they will not be able to until the code exists.)

Worst three, one line each:

1. **Finding 1**, the most common real-world entry point into a scan (`search_jobs` MCP tool,
   `trigger: 'mcp'`) never reaches the triage call at all, because the spec places triage invocation only
   in `bin/scan.js`'s `main()`.
2. **Finding 11**, shipping this code without the real `config/triage.json` landing in the same deploy
   breaks every scan (not just triage), including the operator's existing unattended daily Task Scheduler
   run, contradicting the spec's own "never blocks the scan" framing.
3. **Finding 2**, the deterministic/model steps can silently auto-resolve a genuinely unreviewed
   review-queue item as `'separate'` (via `applyMark`'s existing explicit-mark side effect), because
   section 2's classification table has no branch for "this row has an open review-queue entry."

---

## What this adversary pass cannot detect

- **Real `claude` CLI behavior.** Finding 7 flags that the `--output-format json` envelope shape is
  unverified against the actual binary; this pass could read the spec and the surrounding code but could
  not execute `claude -p --output-format json --json-schema ...` against a live CLI to confirm or refute
  the assumption. Any other real-CLI quirks (e.g. how `--strict-mcp-config` actually behaves, whether
  `--timeout` truly kills a stuck child cleanly on Windows, whether stderr carries anything useful on
  auth failure) are equally out of reach from spec text alone.
- **Postgres locking/concurrency under real load.** The `SELECT ... FOR UPDATE` race-guard reasoning in
  section 2 and the cross-transaction serialization argument in finding 3 are sound on paper, but this
  pass could not run two real concurrent transactions against a real Postgres instance to confirm lock
  wait behavior, deadlock potential between the deterministic step's per-row locks and any other code
  path that might lock `ic_job_listings` rows in a different order, or actual latency under contention.
- **Actual runtime shape of `ic_scan_runs.stats` in production.** Whether `stats` is ever genuinely NULL
  for a real row (as opposed to defaulting to `'{}'::jsonb`) was checked against the schema and the
  finalize-block code path, not against live data; a historical row created before some now-removed code
  path could in principle carry a NULL this pass did not find.
- **Windows-specific process behavior.** `execFile('claude', [...], { timeout, windowsHide: true })`'s
  actual timeout-kill semantics on Windows (whether a timed-out child truly stops writing to stdout before
  the parent gives up on it, avoiding a partial-write race) cannot be verified without running it.
- **The real `claude -p` model's actual susceptibility to prompt injection.** Section 4's hardening
  block and the spec's own section 10 already acknowledge that "a subtler manipulation is not" provably
  blocked; this pass could not run real injected listings through a real model to characterize how often
  that succeeds in practice, only reason about what the validation ladder can and cannot catch by
  construction.
- **Performance/cost at scale.** Whether the correlated subquery in section 7's `triagedBy=auto` filter,
  or the per-row `FOR UPDATE` locking in the deterministic step, actually stays fast enough at whatever
  row count this operator's database reaches in a year, is not something a spec-only read can measure.
- **Whether other, undiscovered call sites into `runScan()` exist beyond the three found here
  (`bin/scan.js`, `search_jobs.js`, and dashboard's spawn of `bin/scan.js`).** A `grep` for `runScan(`
  covered the current tree; a caller added later, or a dynamic/indirect invocation this pass's search
  patterns did not match, would reproduce finding 1's class of gap without this pass having any way to
  know about it in advance.
