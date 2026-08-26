"""
Query ic_context for relevant coached answers, past session moments, and
company research. Used at the start of coaching sessions to surface relevant
history.

Usage:
  python tools/query_memory.py "stakeholder alignment AI investment ROI"
  python tools/query_memory.py "forward deployed consulting AI automation" --top 5

Output:
  Prints the top matching coached answers, session moments, and company
  research to stdout. Designed to be read directly by Claude as coaching
  context.
"""

import sys
sys.path.insert(0, ".")
import psycopg2.extras
from tools.ic_memory import ICMemory, _embed, _vec_literal

DEFAULT_TOP_K = 5


def search_company_research(mem: ICMemory, query: str, top_k: int):
    """Return the top_k company research records most relevant to query, or
    None if the table is missing or the query fails for any other reason.

    ic_memory.py has no search helper for ic_company_research, so this mirrors
    the query shape used by search_coached_answers and search_session_moments
    directly against the shared connection.
    """
    try:
        vec = _embed(query)
        with mem.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, research_date, company, context, summary,
                       key_people, tags, html_path,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM ic_company_research
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (_vec_literal(vec), _vec_literal(vec), top_k),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        mem.conn.rollback()
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    top_k = DEFAULT_TOP_K
    for i, a in enumerate(sys.argv[1:]):
        if a == "--top" and i + 2 < len(sys.argv):
            top_k = int(sys.argv[i + 2])

    if not args:
        print("Usage: python tools/query_memory.py <query> [--top N]")
        sys.exit(1)

    query = " ".join(args)

    with ICMemory() as mem:
        answers = mem.search_coached_answers(query, top_k=top_k)
        moments = mem.search_session_moments(query, top_k=top_k)
        company_research = search_company_research(mem, query, top_k)

    print(f"\n=== Semantic Memory Query: '{query}' ===\n")

    if answers:
        print("--- Coached Answers ---")
        for r in answers:
            sim = r["similarity"]
            if sim < 0.4:
                continue
            print(f"[{sim:.2f}] {r['question_type']}")
            if r.get("question_text"):
                print(f"  Q: {r['question_text']}")
            print(f"  A: {r['answer_text'][:300]}{'...' if len(r['answer_text']) > 300 else ''}")
            if r.get("tags"):
                print(f"  Tags: {', '.join(r['tags'])}")
            print()
    else:
        print("No coached answers found.\n")

    if moments:
        print("--- Past Session Moments ---")
        for r in moments:
            sim = r["similarity"]
            if sim < 0.4:
                continue
            score = r.get("quality_score")
            company = r.get("company") or "unknown"
            role_type = r.get("role_type") or "session"
            date_str = str(r.get("session_date") or "")
            print(f"[{sim:.2f}] {date_str} | {company} | {role_type} | quality={score}/5")
            print(f"  Q: {r['question'][:120]}")
            print(f"  A: {r['response'][:200]}{'...' if len(r['response']) > 200 else ''}")
            if r.get("coach_notes"):
                print(f"  Coach: {r['coach_notes'][:150]}")
            print()
    else:
        print("No past session moments found.\n")

    if company_research is None:
        print("Company research search unavailable.\n")
    elif company_research:
        print("--- Company Research ---")
        for r in company_research:
            sim = r["similarity"]
            if sim < 0.4:
                continue
            date_str = str(r.get("research_date") or "")
            print(f"[{sim:.2f}] {date_str} | {r['company']}")
            if r.get("context"):
                print(f"  Context: {r['context']}")
            print(f"  Summary: {r['summary'][:300]}{'...' if len(r['summary']) > 300 else ''}")
            if r.get("key_people"):
                people_str = ", ".join(
                    f"{p.get('name', '')} ({p['title']})" if p.get("title") else p.get("name", "")
                    for p in r["key_people"] if isinstance(p, dict) and p.get("name")
                )
                if people_str:
                    print(f"  Key people: {people_str[:200]}{'...' if len(people_str) > 200 else ''}")
            if r.get("tags"):
                print(f"  Tags: {', '.join(r['tags'])}")
            if r.get("html_path"):
                print(f"  Full brief: {r['html_path']}")
            print()
    else:
        print("No company research found.\n")


if __name__ == "__main__":
    main()
