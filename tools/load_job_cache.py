"""
Parse .claude/skills/scan-jobs/cache.md and bulk-load into ic_job_listings.

Run:
  python tools/load_job_cache.py [--dry-run]

Skips rows where title+company already exists (exact match) to allow safe re-runs.
"""

import re
import sys
from datetime import date
sys.path.insert(0, ".")
from tools.ic_memory import ICMemory

CACHE_FILE = ".claude/skills/scan-jobs/cache.md"


def parse_date(s: str) -> date | None:
    s = s.strip()
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def parse_cache(text: str) -> list[dict]:
    entries = []
    in_table = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("| Title"):
            in_table = True
            continue
        if line.startswith("|---"):
            continue
        if not in_table or not line.startswith("|"):
            continue

        cols = [c.strip() for c in line.strip("|").split("|")]
        if len(cols) < 7:
            continue

        title, company, fit_raw, status, ad_date_raw, url_raw, notes = (
            cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6]
        )

        # Parse fit score
        fit_match = re.search(r"(\d+)", fit_raw)
        fit_score = int(fit_match.group(1)) if fit_match else None

        # Parse URL from markdown link
        url_match = re.search(r"\[.*?\]\((.*?)\)", url_raw)
        url = url_match.group(1) if url_match else None

        ad_date = parse_date(ad_date_raw)

        entries.append({
            "title": title,
            "company": company,
            "fit_score": fit_score,
            "status": status,
            "ad_date": ad_date,
            "url": url,
            "notes": notes,
        })

    return entries


def already_exists(mem: ICMemory, title: str, company: str) -> bool:
    import psycopg2.extras
    with mem.conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM ic_job_listings WHERE lower(title)=lower(%s) AND lower(company)=lower(%s)",
            (title, company),
        )
        return cur.fetchone() is not None


def main():
    dry_run = "--dry-run" in sys.argv

    with open(CACHE_FILE, encoding="utf-8") as f:
        text = f.read()

    entries = parse_cache(text)
    print(f"Found {len(entries)} entries in cache")

    if dry_run:
        for e in entries:
            print(f"  [{e['fit_score']}% {e['status']}] {e['title']} @ {e['company']}")
        return

    with ICMemory() as mem:
        new_entries = [e for e in entries if not already_exists(mem, e["title"], e["company"])]
        skipped = len(entries) - len(new_entries)

        if not new_entries:
            print(f"All {skipped} entries already in DB. Nothing to do.")
            return

        print(f"Loading {len(new_entries)} new entries ({skipped} already existed)...")
        ids = mem.store_job_listings_batch(new_entries)
        for e, row_id in zip(new_entries, ids):
            print(f"  id={row_id}: {e['title']} @ {e['company']}")

    print(f"Done. {len(new_entries)} loaded, {skipped} skipped.")


if __name__ == "__main__":
    main()
