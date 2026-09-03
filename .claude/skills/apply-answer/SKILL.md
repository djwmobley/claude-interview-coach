---
name: apply-answer
description: Draft an answer to one parked screening question on an application awaiting human input, strictly from your own data files, and post it only after your explicit approval
argument-hint: <application-id> [--dry-run] [--no-save]
user-invocable: true
allowed-tools: Bash(curl:*), Bash(grep:*), Read(*)
---

# Answer a Parked Screening Question

Draft an answer to ONE application that is parked in `needs_human` with a `question`-kind pending question (apply pipeline slice 5's screening-question flow), show the exact text and where it will be saved, and post it to the dashboard ONLY after the candidate explicitly approves. This skill never fills a form itself and never invents an answer -- everything it proposes comes from files already in this repo's `data/` directory.

## Arguments

- `$ARGUMENTS`: `<application-id> [--dry-run] [--no-save]`
  - **application-id** (required): the `ic_job_applications.id` shown on the application's card in the dashboard.
  - `--dry-run` (optional): draft and show the answer, then stop. Never posts, regardless of anything the candidate says in the same turn.
  - `--no-save` (optional): post the answer for this run only; do not promote the label into the answer bank's `learned:` store. Without this flag, `save` defaults to `true` (the apply pipeline's own "save-by-default" rule for durable facts).

## Dashboard base URL

Loopback-only, same instance the `/scan-jobs` and dashboard docs use. Default port `7311` (`DASHBOARD_PORT` in `mcp/job-search/.env`, default when unset). If a call below fails to connect, check `mcp/job-search/.env` for a non-default `DASHBOARD_PORT` and substitute it.

```
BASE=http://127.0.0.1:7311
```

## Instructions

### Step 1: Fetch the application

```
curl -s $BASE/api/applications/<application-id>
```

If the request fails to connect, tell the candidate the dashboard is not running (`npm run dashboard` from `mcp/job-search/`) and stop.

### Step 2: Check the pending question kind

Read `row.state` and `row.pending_question` from the response.

**If `row.state` is not `needs_human`, or `row.pending_question` is missing, or `row.pending_question.kind` is not `'question'`:** print a short, non-actionable message naming the actual kind (`credential`, `captcha`, `document_drift`, `post_submit_uncertain`, `unrecognized_page`, `unsupported_ats`, or whatever the field holds) and STOP. This skill only handles the `question` kind; every other kind needs a different action (a credential fix, a captcha solved by hand, and so on) that this skill does not perform.

Only continue past this point when `pending_question.kind === 'question'`.

### Step 3: Show the question and screenshot

Show the candidate `pending_question.label` verbatim, and the screenshot path:

```
curl -s -o /tmp/apply-answer-<application-id>.png $BASE/api/applications/<application-id>/screenshot
```

Then `Read` that PNG so the candidate can see the actual field on the page before answering. A missing screenshot (404) is not fatal -- say so and continue from the label text alone.

### Step 4: Draft the answer strictly from data files

Read only from this repo's own data: `data/profile.md`, `data/projects/*.md`, `data/skills.md`, `data/certifications.md`, `coaching/coached-answers.md`. Never invent a fact that is not already recorded somewhere in these files. If the question asks for something not covered by any of them (a fact the candidate has never recorded), say so explicitly and ask the candidate for the answer instead of guessing one.

If `pending_question.suggestion` is present (an alias/synonym-tier match already resolved a bank key and a candidate value, per `src/apply/answers.js`'s three-tier matcher), lead with that value -- it is already the candidate's own recorded fact for this key, just not yet confirmed for this exact site wording.

### Step 5: Show the exact text and where it will be saved

Before asking for approval, show BOTH:

1. The exact answer text this skill will POST.
2. The bank line that will be appended if `save` promotes it -- `learned: <pending_question.label, exactly as returned>` under `pending_question.suggestion.key` (skip this second part when there is no `suggestion.key`: the dashboard route itself is a no-op for `save` in that case, since there is no key to attach a learned label to).

### Step 6: Stop and wait for explicit approval

**STOP and wait for explicit user approval before posting anything.** Do not treat drafting the answer, or the candidate reading it, as approval. Approval is the candidate saying yes/post it/looks good or an equivalent explicit go-ahead in their next message.

**`--dry-run` always stops here**, even if the candidate approves in the same turn the draft was shown -- re-run the skill without `--dry-run` to actually post.

### Step 7: Post the answer

Only after explicit approval, and only when `--dry-run` was not passed:

```
curl -s -X POST $BASE/api/applications/<application-id>/answer \
  -H 'Content-Type: application/json' \
  -d '{"text": "<answer text>", "save": <true unless --no-save>}'
```

This skill never computes whether `save` will actually promote a `learned:` label -- `POST /api/applications/:id/answer` (`src/dashboard/routes/applications.js`) owns that decision (it is a no-op when the pending question carries no bank key, regardless of `save`). Report the response's `row.state` back to the candidate; a resumed application kicks the apply runner automatically, so the candidate does not need to do anything else.

## What this skill does not do

- It never fills the application form itself -- only the dashboard-driven apply worker (`src/apply/worker.js`) does that, and only after this skill's own POST resumes the application.
- It never posts without an explicit approval in the conversation, and `--dry-run` never posts at all.
- It never invents an answer not already recorded in `data/`; an unrecorded fact is a question for the candidate, not a guess.
- It never handles any `pending_question.kind` other than `'question'`.
