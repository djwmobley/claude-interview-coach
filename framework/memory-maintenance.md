# Semantic Memory Maintenance

## Architecture

All semantic memory for this project runs locally:

- **Database:** PostgreSQL (`ic_context`, localhost:5432)
  - `ic_coached_answers`: coached Q&A frameworks, indexed for retrieval
  - `ic_session_moments`: key exchanges from past coaching sessions
  - `ic_job_listings`: job scan history with semantic dedup
- **Embedding model:** `mxbai-embed-large` via Ollama (localhost:11434)
  - 1024 dimensions, cosine similarity, HNSW indexes
  - No API calls, no rate limits, no cost
- **Fallback:** Voyage AI (`voyage-3`): activates automatically if Ollama is unreachable

All embedding and retrieval goes through `tools/ic_memory.py`. Do not call Voyage AI
directly. Do not bypass the local stack. Every tool that touches embeddings must
import from `ic_memory.py`.

---

## Weekly Model Check

**Check at the start of the first session each week.**

### 1. Check installed version

```bash
ollama show mxbai-embed-large
```

Note the current digest/version shown.

### 2. Check for updates

```bash
ollama pull mxbai-embed-large
```

Ollama will report "already up to date" if nothing changed, or download the
new version if one exists.

### 3. If a new version was downloaded: re-embed all records

When the model updates, existing vectors become inconsistent with new ones.
Re-embed everything before the next query:

```bash
python tools/reembed_all.py
```

This script walks all three tables with keyset paging on `id`, embeds in
batches of 32, and commits per batch. Idempotent, safe to re-run, and bounded
in memory on tables with thousands of rows. The Node side has an equivalent for
job listings only: `node mcp/job-search/bin/backfill-embeddings.js --all`.

---

## Maintenance Scripts

| Script | Purpose | When to run |
|--------|---------|-------------|
| `tools/reembed_all.py` | Re-embed all records after model update | After `ollama pull` downloads a new version |
| `tools/load_coached_answers.py` | Sync coached-answers.md to DB | After any update to `coaching/coached-answers.md` |
| `tools/load_job_cache.py` | Sync cache.md to DB (legacy) | Only for rows that predate the job-search MCP. New scan rows are written by `mcp/job-search`; do not re-import cache.md over them. |
| `mcp/job-search/bin/migrate.js --check` | Verify `ic_job_listings` schema, dedup columns, review-queue invariant | After any manual change to `ic_job_listings` or before a scan after a schema edit |
| `mcp/job-search/bin/backfill-embeddings.js` | Embed listing rows with NULL embedding (Ollama was down during a scan) | When a scan reports `unembedded > 0` |
| `mcp/job-search/bin/scan.js` | Unattended job scan (writes `ic_job_listings`, `ic_scan_runs`, review queue) | Task Scheduler, weekdays; or by hand for an offline run |
| `mcp/job-search/bin/remind.js` | Email the daily digest of due follow-ups from `ic_followups` | Task Scheduler, weekdays 07:00 |
| `mcp/job-search/bin/config-lock.js --write` | Refresh `config.lock.json` after an intentional edit to `config/*.json` | After any scan config edit, before the next unattended run |
| `tools/query_memory.py "<query>"` | Semantic search across all tables | Before coaching sessions |
| `tools/store_scan_results.py` | Legacy manual insert of listings (no dedup columns) | Only by hand; rows it inserts are adopted and classified at the start of the next scan |

---

## Scheduled Jobs (Windows Task Scheduler)

Both jobs run as the interactive user (not "run whether user is logged on or
not"): the scan needs the dedicated scan Chrome, which only exists in an
interactive session. Register from an elevated PowerShell in the repo root:

```powershell
$root = "C:\claude-interview-coach\claude-interview-coach"

# Job scan: weekdays 06:30, random delay up to 45 min, degrades to partial when the scan Chrome is down
$a = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\scan.js --profile exec-default --json" -WorkingDirectory $root
$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 06:30
$t.RandomDelay = "PT45M"
Register-ScheduledTask -TaskName "job-search scan" -Action $a -Trigger $t -RunLevel Limited

# Follow-up digest: weekdays 07:00, no random delay
$a2 = New-ScheduledTaskAction -Execute "node" -Argument "mcp\job-search\bin\remind.js" -WorkingDirectory $root
$t2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 07:00
Register-ScheduledTask -TaskName "job-search remind" -Action $a2 -Trigger $t2 -RunLevel Limited
```

Checks after a scheduled run:
- `mcp/job-search/logs/scan-YYYY-MM-DD.log` and `remind-YYYY-MM-DD.log` exist (JSONL, 14-day retention).
- `SELECT id, status, trigger, finished_at FROM ic_scan_runs ORDER BY id DESC LIMIT 3;` shows a `cli` row.
- Exit 2 from `scan.js` means partial or locked (read `errors` on the run row); exit 1 means failed or a config-lock mismatch.
- Exit 1 from `remind.js` means the Google grant is stale or the send failed; due items stay un-stamped and are retried tomorrow. Re-run the workspace-mcp auth flow, then `node mcp/job-search/bin/remind.js --dry-run` to confirm `scopes_ok`.

Full details, env vars, and the scan Chrome procedure: `mcp/job-search/README.md`.

---

## Changing the Embedding Model

If switching from `mxbai-embed-large` to a different model:

1. Update `OLLAMA_MODEL` and `VECTOR_DIM` in `tools/ic_memory.py`
2. If dimensions change, drop the HNSW indexes FIRST (the ALTER fails while an
   HNSW index exists on the column), alter, then recreate:
   ```sql
   DROP INDEX IF EXISTS ic_coached_answers_hnsw;
   DROP INDEX IF EXISTS ic_session_moments_hnsw;
   DROP INDEX IF EXISTS ic_job_listings_hnsw;
   ALTER TABLE ic_coached_answers ALTER COLUMN embedding TYPE vector(NEW_DIM);
   ALTER TABLE ic_session_moments ALTER COLUMN embedding TYPE vector(NEW_DIM);
   ALTER TABLE ic_job_listings    ALTER COLUMN embedding TYPE vector(NEW_DIM);
   CREATE INDEX ic_coached_answers_hnsw ON ic_coached_answers USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
   CREATE INDEX ic_session_moments_hnsw ON ic_session_moments USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
   CREATE INDEX ic_job_listings_hnsw    ON ic_job_listings    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
   ```
   Also update `VECTOR_DIM` in `mcp/job-search/src/core/embed.js` (the Node
   server asserts 1024 dims on every embedding and refuses others).
3. Run `python tools/reembed_all.py` to re-embed everything

---

## Connection Details

```
Host:     localhost
Port:     5432
Database: ic_context
User:     postgres
```

Ollama API: `http://localhost:11434`
