"""
Store key Q&A moments from a coaching session into ic_session_moments.
Called by the debrief skill and interview-workflow after every session.

Usage: pipe JSON array to stdin:
  echo '[{"question":"...", "response":"...", ...}]' | python tools/store_session_moments.py

Or pass a JSON file:
  python tools/store_session_moments.py moments.json

JSON fields per moment:
  question      (str, required)
  response      (str, required)
  coach_notes   (str, optional): coach's feedback on this answer
  quality_score (int 1-5, optional)
  company       (str, optional): company the role was at
  role_type     (str, optional): "recruiter" or "hiring_manager"
  session_date  (str YYYY-MM-DD, optional): defaults to today
  tags          (list[str], optional)

Only moments with quality_score <= 3 or explicit coach_notes are worth storing
(high-quality clean answers add less retrieval value than coached corrections).
The skill decides what to include: this script stores whatever it receives.
"""

import json
import sys
from datetime import date, datetime

sys.path.insert(0, ".")
from tools.ic_memory import ICMemory


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
            moments = json.load(f)
    else:
        moments = json.loads(sys.stdin.read())

    if not moments:
        print("No moments provided.")
        return

    with ICMemory() as mem:
        texts = [
            f"Q: {m['question']}\nA: {m['response']}\nNotes: {m.get('coach_notes') or ''}"
            for m in moments
        ]
        from tools.ic_memory import _embed_batch, _vec_literal
        import psycopg2
        vecs = _embed_batch(texts)

        ids = []
        with mem.conn.cursor() as cur:
            for m, vec in zip(moments, vecs):
                cur.execute(
                    """
                    INSERT INTO ic_session_moments
                        (session_date, company, role_type, question, response,
                         coach_notes, quality_score, tags, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
                    RETURNING id
                    """,
                    (
                        parse_date(m.get("session_date")) or date.today(),
                        m.get("company"),
                        m.get("role_type"),
                        m["question"],
                        m["response"],
                        m.get("coach_notes"),
                        m.get("quality_score"),
                        m.get("tags") or [],
                        _vec_literal(vec),
                    ),
                )
                ids.append(cur.fetchone()[0])
        mem.conn.commit()

    for m, row_id in zip(moments, ids):
        print(f"  id={row_id} [{m.get('quality_score', '?')}/5]: {m['question'][:70]}")
    print(f"Done. {len(ids)} session moments stored.")


if __name__ == "__main__":
    main()
