"""
Interview coach semantic memory — local Ollama embeddings + pgvector.

Database: ic_context (localhost:5432, PostgreSQL)
Model:    mxbai-embed-large via Ollama (localhost:11434) — 1024 dimensions, cosine similarity

WEEKLY MAINTENANCE: Run `ollama pull mxbai-embed-large` at the start of the first
session each week. If a new version downloads, run `python tools/reembed_all.py`
to keep all vectors consistent. See framework/memory-maintenance.md for full procedure.

Tables:
  ic_coached_answers  — coached answers and frameworks
  ic_session_moments  — key exchanges from coaching sessions
  ic_job_listings     — job scan cache with semantic dedup

Usage:
  from tools.ic_memory import ICMemory
  mem = ICMemory()

  # Store a coached answer
  mem.store_coached_answer(
      question_type="stakeholder_alignment",
      question_text="How do you get buy-in from a skeptical CFO?",
      answer_text="...",
      tags=["finance", "buy-in", "investment-case"]
  )

  # Find closest coached answer to a new question
  results = mem.search_coached_answers("How do you handle executive resistance to AI?", top_k=3)

  # Store a job listing
  mem.store_job_listing(title="VP of AI", company="IDC", fit_score=48,
                        status="maybe", ad_date="2026-03-03",
                        url="https://...", notes="Forward-deployed model match")

  # Check for semantic duplicate before storing
  dupes = mem.find_similar_jobs("VP AI Automation", "IDC", threshold=0.92)
"""

import json
import urllib.request
from datetime import date
from typing import Optional

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    raise ImportError("psycopg2 required: pip install psycopg2-binary")

# ── Embedding configuration ───────────────────────────────────────────────────
# Ollama local (no rate limits, no cost)

OLLAMA_ENDPOINT  = "http://localhost:11434/v1/embeddings"
OLLAMA_MODEL     = "mxbai-embed-large"

VECTOR_DIM       = 1024

DB_DSN = "host=localhost port=5432 dbname=ic_context user=postgres"


def _embed(text: str) -> list[float]:
    """Embed a single text using the local Ollama model."""
    return _embed_batch([text])[0]


def _embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts using the local Ollama model."""
    payload = json.dumps({"model": OLLAMA_MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        OLLAMA_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return [item["embedding"] for item in sorted(data["data"], key=lambda x: x["index"])]


def _vec_literal(vec: list[float]) -> str:
    """Format a vector as a Postgres literal."""
    return "[" + ",".join(str(v) for v in vec) + "]"


class ICMemory:
    def __init__(self):
        self.conn = psycopg2.connect(DB_DSN)
        self.conn.autocommit = False

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ── Coached Answers ───────────────────────────────────────────────────────

    def store_coached_answer(
        self,
        answer_text: str,
        question_type: str,
        question_text: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> int:
        """Embed and store a coached answer. Returns the new row id."""
        embed_input = f"{question_type}: {question_text or ''}\n\n{answer_text}"
        vec = _embed(embed_input)
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ic_coached_answers
                    (question_type, question_text, answer_text, tags, embedding)
                VALUES (%s, %s, %s, %s, %s::vector)
                RETURNING id
                """,
                (question_type, question_text, answer_text,
                 tags or [], _vec_literal(vec)),
            )
            row_id = cur.fetchone()[0]
        self.conn.commit()
        return row_id

    def search_coached_answers(self, query: str, top_k: int = 5) -> list[dict]:
        """Return the top_k coached answers most semantically similar to query."""
        vec = _embed(query)
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, question_type, question_text, answer_text, tags,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM ic_coached_answers
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (_vec_literal(vec), _vec_literal(vec), top_k),
            )
            return [dict(r) for r in cur.fetchall()]

    def store_job_listings_batch(self, listings: list[dict]) -> list[int]:
        """Embed and store multiple job listings in a single embedding call."""
        texts = [f"{e['title']} at {e['company']}. {e.get('notes') or ''}"
                 for e in listings]
        vecs = _embed_batch(texts)
        ids = []
        with self.conn.cursor() as cur:
            for e, vec in zip(listings, vecs):
                cur.execute(
                    """
                    INSERT INTO ic_job_listings
                        (title, company, fit_score, status, ad_date, url, notes, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                    RETURNING id
                    """,
                    (e["title"], e["company"], e.get("fit_score"), e.get("status"),
                     e.get("ad_date"), e.get("url"), e.get("notes"),
                     _vec_literal(vec)),
                )
                ids.append(cur.fetchone()[0])
        self.conn.commit()
        return ids

    def store_coached_answers_batch(self, answers: list[dict]) -> list[int]:
        """Embed and store multiple coached answers in a single embedding call."""
        texts = [
            f"{e['question_type']}: {e.get('question_text') or ''}\n\n{e['answer_text']}"
            for e in answers
        ]
        vecs = _embed_batch(texts)
        ids = []
        with self.conn.cursor() as cur:
            for e, vec in zip(answers, vecs):
                cur.execute(
                    """
                    INSERT INTO ic_coached_answers
                        (question_type, question_text, answer_text, tags, embedding)
                    VALUES (%s, %s, %s, %s, %s::vector)
                    RETURNING id
                    """,
                    (e["question_type"], e.get("question_text"), e["answer_text"],
                     e.get("tags") or [], _vec_literal(vec)),
                )
                ids.append(cur.fetchone()[0])
        self.conn.commit()
        return ids

    # ── Session Moments ───────────────────────────────────────────────────────

    def store_session_moment(
        self,
        question: str,
        response: str,
        coach_notes: Optional[str] = None,
        quality_score: Optional[int] = None,
        company: Optional[str] = None,
        role_type: Optional[str] = None,
        session_date: Optional[date] = None,
        tags: Optional[list[str]] = None,
    ) -> int:
        embed_input = f"Q: {question}\nA: {response}\nNotes: {coach_notes or ''}"
        vec = _embed(embed_input)
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ic_session_moments
                    (session_date, company, role_type, question, response,
                     coach_notes, quality_score, tags, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
                RETURNING id
                """,
                (session_date or date.today(), company, role_type,
                 question, response, coach_notes, quality_score,
                 tags or [], _vec_literal(vec)),
            )
            row_id = cur.fetchone()[0]
        self.conn.commit()
        return row_id

    def search_session_moments(self, query: str, top_k: int = 5) -> list[dict]:
        """Return the top_k session moments most relevant to query."""
        vec = _embed(query)
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, session_date, company, role_type, question, response,
                       coach_notes, quality_score, tags,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM ic_session_moments
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (_vec_literal(vec), _vec_literal(vec), top_k),
            )
            return [dict(r) for r in cur.fetchall()]

    # ── Job Listings ──────────────────────────────────────────────────────────

    def store_job_listing(
        self,
        title: str,
        company: str,
        fit_score: Optional[int] = None,
        status: Optional[str] = None,
        ad_date: Optional[date] = None,
        url: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> int:
        embed_input = f"{title} at {company}. {notes or ''}"
        vec = _embed(embed_input)
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ic_job_listings
                    (title, company, fit_score, status, ad_date, url, notes, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
                RETURNING id
                """,
                (title, company, fit_score, status, ad_date, url, notes,
                 _vec_literal(vec)),
            )
            row_id = cur.fetchone()[0]
        self.conn.commit()
        return row_id

    def find_similar_jobs(
        self, title: str, company: str, threshold: float = 0.92
    ) -> list[dict]:
        """Check for semantic duplicates before storing a new listing."""
        embed_input = f"{title} at {company}"
        vec = _embed(embed_input)
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, title, company, status,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM ic_job_listings
                WHERE 1 - (embedding <=> %s::vector) >= %s
                  AND duplicate_of IS NULL AND expired_at IS NULL
                  AND coalesce(record_kind, 'listing') = 'listing'
                ORDER BY embedding <=> %s::vector
                LIMIT 5
                """,
                (_vec_literal(vec), _vec_literal(vec), threshold, _vec_literal(vec)),
            )
            return [dict(r) for r in cur.fetchall()]

    def update_job_status(self, job_id: int, status: str):
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE ic_job_listings SET status = %s WHERE id = %s",
                (status, job_id),
            )
        self.conn.commit()

    def search_job_listings(self, query: str, top_k: int = 10) -> list[dict]:
        vec = _embed(query)
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, title, company, fit_score, status, ad_date, url, notes,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM ic_job_listings
                WHERE duplicate_of IS NULL AND expired_at IS NULL
                  AND coalesce(record_kind, 'listing') = 'listing'
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (_vec_literal(vec), _vec_literal(vec), top_k),
            )
            return [dict(r) for r in cur.fetchall()]


# ── CLI quick-test ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Testing ic_memory...")
    with ICMemory() as mem:
        # Round-trip test
        aid = mem.store_coached_answer(
            question_type="stakeholder_alignment",
            question_text="How do you get buy-in from a skeptical CFO on an AI program?",
            answer_text=(
                "Every AI initiative I've run started with a self-financing sequence. "
                "The CFO doesn't need to believe in AI; they need to see that use case 1 "
                "pays for itself before use case 2 starts. Map the labor savings to a "
                "specific line on their P&L and sequence the portfolio so the first "
                "deployment is the cheapest and fastest to prove. The architecture "
                "conversation comes after the ROI conversation, not before."
            ),
            tags=["finance", "buy-in", "roi", "investment-case"],
        )
        print(f"Stored coached answer id={aid}")

        results = mem.search_coached_answers(
            "How do you convince an executive to fund AI when they're skeptical?", top_k=3
        )
        for r in results:
            print(f"  [{r['similarity']:.3f}] {r['question_type']}: {r['answer_text'][:80]}...")

    print("Done.")
