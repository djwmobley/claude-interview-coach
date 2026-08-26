"""
Parse coaching/coached-answers.md and bulk-load into ic_coached_answers.

Entry format expected:
  ## [Question Type]
  **Q:** [question text]
  **Tags:** tag1, tag2
  [one or more paragraphs of answer text]

Run:
  python tools/load_coached_answers.py [--dry-run]
"""

import re
import sys
sys.path.insert(0, ".")
from tools.ic_memory import ICMemory

COACHED_FILE = "coaching/coached-answers.md"


def parse_entries(text: str) -> list[dict]:
    entries = []
    # Split on ## headings
    sections = re.split(r"^## ", text, flags=re.MULTILINE)
    for section in sections:
        section = section.strip()
        if not section:
            continue
        lines = section.splitlines()
        question_type = lines[0].strip()

        question_text = None
        tags = []
        answer_lines = []

        for line in lines[1:]:
            q_match = re.match(r"\*\*Q:\*\*\s*(.+)", line)
            t_match = re.match(r"\*\*Tags:\*\*\s*(.+)", line)
            if q_match:
                question_text = q_match.group(1).strip()
            elif t_match:
                tags = [t.strip() for t in t_match.group(1).split(",")]
            else:
                answer_lines.append(line)

        answer_text = "\n".join(answer_lines).strip()
        if not answer_text:
            continue

        entries.append({
            "question_type": question_type,
            "question_text": question_text,
            "answer_text": answer_text,
            "tags": tags,
        })

    return entries


def already_exists(mem: ICMemory, question_type: str, question_text: str | None,
                   answer_text: str) -> bool:
    with mem.conn.cursor() as cur:
        if question_text:
            cur.execute(
                "SELECT id FROM ic_coached_answers "
                "WHERE lower(question_type)=lower(%s) AND lower(question_text)=lower(%s)",
                (question_type, question_text),
            )
        else:
            cur.execute(
                "SELECT id FROM ic_coached_answers "
                "WHERE lower(question_type)=lower(%s) AND left(lower(answer_text),120)=left(lower(%s),120)",
                (question_type, answer_text),
            )
        return cur.fetchone() is not None


def main():
    dry_run = "--dry-run" in sys.argv

    with open(COACHED_FILE, encoding="utf-8") as f:
        text = f.read()

    entries = parse_entries(text)
    print(f"Found {len(entries)} entries in {COACHED_FILE}")

    if not entries:
        print("Nothing to load.")
        return

    if dry_run:
        for e in entries:
            print(f"  [{e['question_type']}] q={str(e['question_text'])[:60]} "
                  f"answer={e['answer_text'][:60]}...")
        return

    loaded = skipped = 0
    with ICMemory() as mem:
        new_entries = [e for e in entries
                       if not already_exists(mem, e["question_type"],
                                             e["question_text"], e["answer_text"])]
        skipped = len(entries) - len(new_entries)

        if not new_entries:
            print(f"All {skipped} entries already in DB.")
            return

        ids = mem.store_coached_answers_batch(new_entries)
        for e, row_id in zip(new_entries, ids):
            print(f"  id={row_id}: {e['question_type']}")

    print(f"Done. {len(new_entries)} loaded, {skipped} skipped.")


if __name__ == "__main__":
    main()
