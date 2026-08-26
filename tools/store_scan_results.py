"""
Store newly scanned job listings into ic_job_listings.
Called by the scan-jobs skill after each scan, with new listings as JSON on stdin.

Usage:
  echo '[{"title":"...", "company":"...", ...}]' | python tools/store_scan_results.py

Or pass a JSON file:
  python tools/store_scan_results.py listings.json

JSON fields per listing:
  title, company, fit_score (int), status, ad_date (YYYY-MM-DD), url, notes

Already-existing listings (by exact title+company) are skipped.
"""

import json
import sys
sys.path.insert(0, ".")
from tools.ic_memory import ICMemory


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            listings = json.load(f)
    else:
        listings = json.loads(sys.stdin.read())

    if not listings:
        print("No listings provided.")
        return

    from datetime import date
    for e in listings:
        if isinstance(e.get("ad_date"), str):
            try:
                e["ad_date"] = date.fromisoformat(e["ad_date"])
            except ValueError:
                e["ad_date"] = None

    with ICMemory() as mem:
        new = [e for e in listings
               if not _already_exists(mem, e["title"], e["company"])]
        skipped = len(listings) - len(new)

        if not new:
            print(f"All {skipped} listings already in DB.")
            return

        ids = mem.store_job_listings_batch(new)
        for e, row_id in zip(new, ids):
            print(f"Stored id={row_id}: {e['title']} @ {e['company']}")
        print(f"Done. {len(new)} stored, {skipped} skipped.")


def _already_exists(mem, title, company):
    with mem.conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM ic_job_listings WHERE lower(title)=lower(%s) AND lower(company)=lower(%s)",
            (title, company),
        )
        return cur.fetchone() is not None


if __name__ == "__main__":
    main()
