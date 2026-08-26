"""
Re-embed all records in ic_context after an Ollama model update.

Walks each table with keyset paging on id (never SELECT *), embeds in
batches of 32, and commits after every batch. Safe to re-run at any time and
safe on tables with thousands of rows: memory use is bounded by the batch.

Usage:
  python tools/reembed_all.py
  python tools/reembed_all.py --batch 32
"""

import sys
sys.path.insert(0, ".")
import psycopg2
import psycopg2.extras
from tools.ic_memory import _embed_batch, _vec_literal, DB_DSN, OLLAMA_MODEL

BATCH_SIZE = 32


def reembed_table(conn, table, columns, text_fn, label, batch_size=BATCH_SIZE):
    """Re-embed one table using keyset paging on id.

    columns: explicit column list needed by text_fn (id is added automatically).
    """
    col_sql = ", ".join(["id"] + [c for c in columns if c != "id"])
    last_id = 0
    total = 0
    while True:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"SELECT {col_sql} FROM {table} WHERE id > %s ORDER BY id LIMIT %s",
                (last_id, batch_size),
            )
            rows = cur.fetchall()
        if not rows:
            break
        last_id = rows[-1]["id"]
        vecs = _embed_batch([text_fn(r) for r in rows])
        with conn.cursor() as cur:
            for r, vec in zip(rows, vecs):
                cur.execute(
                    f"UPDATE {table} SET embedding = %s::vector WHERE id = %s",
                    (_vec_literal(vec), r["id"]),
                )
        conn.commit()
        total += len(rows)
        print(f"  {label}: {total} rows (through id {last_id})")
    if total == 0:
        print(f"  {label}: no records, skipping")
    else:
        print(f"  {label}: done ({total} rows)")


def main():
    batch_size = BATCH_SIZE
    args = sys.argv[1:]
    if "--batch" in args:
        i = args.index("--batch")
        if i + 1 < len(args):
            batch_size = max(1, min(64, int(args[i + 1])))

    print(f"Re-embedding all ic_context tables using model: {OLLAMA_MODEL} (batch {batch_size})\n")
    conn = psycopg2.connect(DB_DSN)

    reembed_table(
        conn,
        table="ic_coached_answers",
        columns=["question_type", "question_text", "answer_text"],
        text_fn=lambda r: f"{r['question_type']}: {r['question_text'] or ''}\n\n{r['answer_text']}",
        label="ic_coached_answers",
        batch_size=batch_size,
    )

    reembed_table(
        conn,
        table="ic_session_moments",
        columns=["question", "response", "coach_notes"],
        text_fn=lambda r: f"Q: {r['question']}\nA: {r['response']}\nNotes: {r['coach_notes'] or ''}",
        label="ic_session_moments",
        batch_size=batch_size,
    )

    reembed_table(
        conn,
        table="ic_job_listings",
        columns=["title", "company", "notes"],
        text_fn=lambda r: f"{r['title']} at {r['company']}. {r['notes'] or ''}",
        label="ic_job_listings",
        batch_size=batch_size,
    )

    conn.close()
    print("\nAll tables re-embedded.")


if __name__ == "__main__":
    main()
