# Review queue bulk resolve

Status: implemented. Records the S1/S2/S3 spec this feature was built against, so a later change does
not have to re-derive the classification rule or the closed reason lists from the code alone.

## 1. Scope

Four modes: `rule`, `reason`, and `stale` only ever perform the `separate` resolution against
`ic_job_review_queue`, in bulk. `sticky-skip` (added by the sticky-skip spec, part C) is the one mode
that performs `merge` instead -- into a STICKY-ELIGIBLE root: a matched root listing whose status is
`skip`/`passed`/`lost` and whose most recent status-change event to that status was either a human
(dashboard/mcp/cli) or an auto-triage `skip_noise` call. `repost` is never performed in bulk by any
mode; it stays a one-at-a-time human action through the existing `review` MCP tool action `resolve`,
or the dashboard Review page's per-card buttons.

## 2. The rule-mode classifier (S1)

`classifyForBulkSeparate(item, candidate, match)` in `src/core/review-bulk.js` is a total
classification: every input maps to exactly one of ten branches (one `separate` branch, nine `leave`
branches), checked in this precedence order:

1. `not_open`: the queue item already carries a resolution.
2. `wrong_reason`: the item's reason is not `title_similar_same_company`.
3. `multi_match`: the item does not carry exactly one match id, or that match row could not be loaded.
4. `status_changed`: the candidate row is missing, or its status is no longer `review`.
5. `company_differs`: the candidate and match rows have different `company_norm`.
6. `title_key_differs`: `titleTokenKey(candidate.title_norm)` differs from `titleTokenKey(match.title_norm)`.
7. `location_unknown`: either side's `location_norm` fails `isLocationEligible` (absent, `legacy-unknown`,
   or `unknown:*`).
8. `location_same`: the two `location_norm` values are identical.
9. `remote_involved`: either side's `location_norm` is a `remote-*` value.
10. Otherwise: `separate`, rule `same_title_diff_location`.

This is deliberately stricter than the branch-4 creator in `src/core/dedup.js` (around line 444),
which accepts either an identical `titleTokenKey` or a trigram title similarity above the configured
threshold. A bulk, largely unattended separation of many items at once must not rely on a fuzzy
numeric threshold nobody reviewed case by case, so `rule` mode only ever fires on the exact
token-key match. Items that only cleared the trigram-similarity bar stay queued for ordinary,
one-at-a-time review.

The function never throws. A missing candidate or match row (deleted since queuing, or a malformed
caller input) resolves to a `leave` branch (`status_changed` or `multi_match` respectively) rather than
raising.

## 3. bulkResolve (S2)

`bulkResolve(deps, opts)` in `src/tools/review.js` re-queries the open review queue at execution
time, on every call, for every mode. Nothing from an earlier preview is ever reused: an item created
after a dry-run preview is picked up by the next live call, and an item resolved by something else in
the meantime (a concurrent human resolve, or `autoSeparate`) is reported as skipped rather than
retried or double-counted.

Modes:

- `rule`: loads every open item's candidate row and, when it carries exactly one match id, that match
  row, classifies each with `classifyForBulkSeparate`, and separates only the ones that classify as
  `separate`. Every `leave` decision is tallied under its reason in `counts.leave_by_reason`.
- `reason`: separates every open item whose `reason` equals the given value, with no further
  per-item classification. The given reason must be one of the closed nine values in section 4.
- `stale`: separates every open item older than `reviewAutoSeparateDays` (from
  `config/adapters.json`'s `dedup.reviewAutoSeparateDays`, default 30) -- but ONLY after first
  classifying each aged row with the same `classifyForStickySkip()` check `sticky-skip` mode uses
  (independent-review fix): a row whose match resolves to a STICKY-ELIGIBLE root is left untouched
  here, tallied under `counts.left_for_sticky_skip` / `ids.left_for_sticky_skip`, never separated just
  because it aged past the threshold. This closes the gap where aging alone used to bypass the
  `reopened_skip` refusal above -- a `reopened_skip` item with an eligible root now stays queued for
  `mode:'sticky-skip'` regardless of age. Every row that does NOT classify as a sticky merge proceeds
  through the ordinary separate path, unchanged, and is deliberately broader than the existing
  `autoSeparate()` (which only fires when the candidate's status is unchanged since queuing): `stale`
  mode is an explicit, human-triggered action, and `resolveItem`'s own separate branch is already safe
  to call regardless, since it only clears status back to null when the status is still `review`.
  Running `stale` mode after `autoSeparate` has already claimed some of the same rows is expected, not
  an error.
- `sticky-skip`: snapshots every open item of ANY reason (unlike `rule`, which only ever considers
  `title_similar_same_company`), and for each one evaluates MATCH-TEST and SURFACE-EXCEPTION
  (`classifyForStickySkip()`, `src/core/review-bulk.js`) against every id in the item's `matches[]`.
  When at least one match resolves to a STICKY-ELIGIBLE root that MATCH-TEST accepts and
  SURFACE-EXCEPTION does not reject, the item resolves as `merge` into the LOWEST-id such root, via
  `resolveItem({resolution:'merge', targetId})` -- which re-derives STICKY-ELIGIBLE itself, inside its
  own transaction, so a race between this mode's own read-only classification pass and the live resolve
  is always caught there. Rows that fail classification stay open, tallied under
  `counts.leave_by_reason` with one of `STICKY_SKIP_LEAVE_REASONS` (`not_open`, `candidate_missing`,
  `no_matches`, `no_sticky_match`). `mode: 'reason'` with `reason: 'reopened_skip'` is refused (a
  VALIDATION error naming `sticky-skip`): those items now resolve here, where STICKY-ELIGIBLE is
  re-checked per candidate, rather than being separated wholesale regardless of who skipped the root or
  why.

A live run (`dryRun: false`) requires `confirm: true`, checked inside `bulkResolve` itself so every
surface (MCP tool, CLI, dashboard route) gets the identical guarantee, not just whichever boundary
happens to validate it first. `dryRun` and `confirm` must be real booleans: the string `"false"` is
never coerced and is rejected as a VALIDATION error at every surface.

`dryRun: true` performs zero database writes. For `rule` mode it classifies from the same read-only
rows a live run would use; for `reason`/`stale` it counts the matching open items. A dry-run preview
does not pre-check `resolveItem`'s own unique-index conflict path (that would need the same extra
query twice for no benefit to the preview), so a live run can separate slightly fewer items than a
preceding dry run counted, with the difference landing in `counts.skipped_by_reason.unique_conflict`.

Each actual separation runs in its own transaction, on its own pooled connection, so one item's
failure never rolls back another's success. An already-resolved item counts as skipped (reason
`already_resolved`), not an error. A unique-index conflict (`resolveItem`'s own
`separate_blocked_unique` branch) also counts as skipped, under reason `unique_conflict`. Any other
per-item error is caught, counted under `counts.errors`, and does not stop the batch.

Every event this writes carries the note `resolved:separate:bulk:<mode>`, with a `:<reason>` suffix
appended for `reason` mode (for example `resolved:separate:bulk:reason:branch1_conflict`), so a
listing's own event history can always tell a bulk separation apart from a one-at-a-time human
resolve, and can identify which mode and (for reason mode) which reason drove it.

Return shape (`merged`/`ids.merged` are additive, populated only by `sticky-skip` mode;
`left_for_sticky_skip`/`ids.left_for_sticky_skip` are additive, populated only by `stale` mode -- every
other mode leaves all four at `0`/`[]`):

```
{
  mode, dryRun,
  counts: { separate, merged, left_for_sticky_skip, leave_by_reason: {...}, skipped_by_reason: {...}, errors },
  ids: { separated: [...], merged: [...], left_for_sticky_skip: [...], skipped: [...], errors: [{ id, message }] },
}
```

## 4. The closed reason list

`mode: 'reason'` only accepts one of these nine values (`BULK_REASON_REASONS` in
`src/core/review-bulk.js`); anything else, including a near-miss typo, is a VALIDATION error before
any query runs:

- `title_similar_same_company`
- `same_source_hash_within_gap`
- `branch1_conflict`
- `hash_location_unknown`
- `concurrent_review`
- `reopened_skip`
- `title_renormalized`
- `cross_source_uncorroborated`
- `company_similar_same_title`

`reopened_skip` remains in this list (other code still checks membership against it), but passing it
as `mode: 'reason'`'s `reason` is refused with a VALIDATION error pointing at `mode: 'sticky-skip'`
(section 3): a blanket separate of every `reopened_skip` item regardless of who skipped the root, or
why, is no longer available -- `sticky-skip` mode re-checks STICKY-ELIGIBLE per candidate instead.

## 5. The untriaged effect

Every bulk separation, regardless of mode, sends the candidate back to untriaged (`status` set to
null), exactly like a one-at-a-time separate. This is not a special case: it is the existing
`resolveItem` behavior, applied many times. Sending many candidates back to untriaged in one bulk
call can re-enter triage and inflate the next digest's "new" count once, the same way any batch of
manual separations would. This is an accepted, documented side effect, not a bug to guard against.

## 6. Surfaces (S3)

- **MCP tool**: `review` gains `action: 'bulk'` with `mode`, `reason`, `dry_run` (boolean, default
  `true`), and `confirm` (boolean, default `false`).
- **CLI**: `bin/review-bulk.js --mode rule|reason|stale|sticky-skip [--reason <reason>] [--dry-run |
  --no-dry-run --confirm]`. `--dry-run` is the default. A live run needs both `--no-dry-run` and
  `--confirm`; `bulkResolve` itself is the single place that rule is enforced, so the CLI, the MCP tool,
  and the dashboard route can never drift out of sync with each other.
- **Dashboard**: the Review page gets a reason filter, whose options come from `GET
  /api/review/reasons` (the DB's current universe of open reasons), never from whichever page of rows
  the client already loaded. Selecting a reason shows a bulk bar ("Return N to untriaged") backed by a
  `mode: 'reason'` dry-run count, with a two-step confirm mirroring the existing per-card Merge
  button before the live `POST /api/review/bulk` call. The route requires `confirm: true` for a live
  request, same as every other surface.
- **Digest**: `src/core/report.js`'s scan report reads today's bulk-separate event notes
  (`resolved:separate:bulk:<mode>[:<reason>]`) and, only when at least one bulk separation happened
  since the report's own window started, prints one line per mode: `Review queue: N returned to
  untriaged by bulk <mode>`. No bulk activity means no line at all, in text, HTML, and markdown alike.

## 7. Accepted side effect: two visible listings after a reason-mode separation

Separating a same-posting pair by `reason` mode (for example two rows queued under
`same_source_hash_within_gap` or `cross_source_uncorroborated`) turns what was one review item into
two independent, visible listings. Auto-apply's own dedup on `apply_url` still prevents applying to
the same posting twice at apply time; if the two rows carry different apply URLs, both may consume a
daily application cap slot. This is the same accepted trade-off a one-at-a-time human separate
already carries; bulk mode does not introduce a new risk here, it only lets it happen at volume.
