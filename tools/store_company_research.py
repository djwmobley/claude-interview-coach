"""
Store company research into ic_company_research (pgvector).
Creates the table if it doesn't exist.

Usage: pipe JSON to stdin or pass a JSON file:
  echo '[{"company":"Sultans", ...}]' | python tools/store_company_research.py
  python tools/store_company_research.py research.json

JSON fields per company:
  company          (str, required): company name
  context          (str, required): why researching (e.g., "meeting intro via Eduardo")
  summary          (str, required): full research summary text
  key_people       (list[dict])  : [{name, title, background, linkedin}]
  key_phrases      (list[str])   : talking points to use in conversation
  client_base      (list[str])   : known clients
  tech_stack       (list[str])   : technologies / platforms
  flags            (list[str])   : cautions or contextual notes
  research_date    (str YYYY-MM-DD): defaults to today
  html_path        (str)         : relative path to HTML briefing file
  tags             (list[str])   : for retrieval filtering
"""

import json
import sys
from datetime import date

sys.path.insert(0, ".")
from tools.ic_memory import ICMemory, _embed_batch, _vec_literal


CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ic_company_research (
    id              SERIAL PRIMARY KEY,
    research_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    company         TEXT NOT NULL,
    context         TEXT,
    summary         TEXT NOT NULL,
    key_people      JSONB,
    key_phrases     JSONB,
    client_base     JSONB,
    tech_stack      JSONB,
    flags           JSONB,
    html_path       TEXT,
    tags            TEXT[],
    embedding       vector(1024)
);
-- HNSW, not ivfflat: this DDL runs alongside CREATE TABLE, so an ivfflat index
-- here is always built on an empty table and its lists hold no usable centroids.
-- Queries then plan an index scan, probe an empty list, and silently return zero
-- rows. HNSW has no empty-build failure mode and matches the other three tables.
CREATE INDEX IF NOT EXISTS ic_company_research_hnsw
    ON ic_company_research USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS ic_company_research_company_idx
    ON ic_company_research (lower(company));
"""


def _ensure_table(conn):
    with conn.cursor() as cur:
        cur.execute(CREATE_TABLE_SQL)
    conn.commit()


def _build_embed_text(entry: dict) -> str:
    """Build a rich text blob for embedding: company + context + summary + key phrases."""
    parts = [
        f"Company: {entry['company']}",
        f"Context: {entry.get('context', '')}",
        entry.get('summary', ''),
    ]
    if entry.get('key_phrases'):
        parts.append("Key phrases: " + " | ".join(entry['key_phrases']))
    if entry.get('client_base'):
        parts.append("Clients: " + ", ".join(entry['client_base']))
    return "\n\n".join(p for p in parts if p)


def parse_date(s) -> date | None:
    if not s:
        return None
    if isinstance(s, date):
        return s
    try:
        return date.fromisoformat(str(s))
    except ValueError:
        return None


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            entries = json.load(f)
    else:
        entries = json.loads(sys.stdin.read())

    if not entries:
        print("No entries provided.")
        return

    if isinstance(entries, dict):
        entries = [entries]

    with ICMemory() as mem:
        _ensure_table(mem.conn)

        texts = [_build_embed_text(e) for e in entries]
        vecs = _embed_batch(texts)

        ids = []
        with mem.conn.cursor() as cur:
            for e, vec in zip(entries, vecs):
                cur.execute(
                    """
                    INSERT INTO ic_company_research
                        (research_date, company, context, summary,
                         key_people, key_phrases, client_base, tech_stack, flags,
                         html_path, tags, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
                    RETURNING id
                    """,
                    (
                        parse_date(e.get("research_date")) or date.today(),
                        e["company"],
                        e.get("context"),
                        e["summary"],
                        json.dumps(e.get("key_people") or []),
                        json.dumps(e.get("key_phrases") or []),
                        json.dumps(e.get("client_base") or []),
                        json.dumps(e.get("tech_stack") or []),
                        json.dumps(e.get("flags") or []),
                        e.get("html_path"),
                        e.get("tags") or [],
                        _vec_literal(vec),
                    ),
                )
                ids.append(cur.fetchone()[0])
        mem.conn.commit()

    for e, row_id in zip(entries, ids):
        print(f"  id={row_id}: {e['company']}")
    print(f"Done. {len(ids)} company research records stored.")


if __name__ == "__main__":
    main()
