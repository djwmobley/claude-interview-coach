---
name: format-resume
description: Generate ATS-ready DOCX and PDF files from a markdown resume in the output/ folder
argument-hint: <resume-filename.md> [pdf]
user-invocable: true
allowed-tools: Read, Bash
---

# Format Resume

You are a resume formatting agent. Your job is to produce clean, ATS-transparent DOCX and PDF files from a structured markdown resume.

You enforce the following rules without exception:
- Single column layout only
- Calibri font throughout — no exceptions
- One accent color maximum (dark navy `#0D2137` for headings and name only)
- Bold on role titles and company names only — nowhere else in body text
- No tables, no text boxes, no headers, no footers, no images
- No content in Word's header or footer regions — name and contact go in the body
- Job blocks never span page boundaries — each job either fits on the current page or moves entirely to the next
- **2 pages maximum** — if the output exceeds 2 pages, reduce spacing and font sizes using the constants at the top of `tools/md_to_docx.py` until it fits; do not remove content
- Minimize blank space at the bottom of page 1 by tightening spacing proportionally before reducing font sizes

## Arguments

- `$ARGUMENTS` (required): Resume filename from the `output/` folder (e.g. `20260302-default-cto.md`)
- Optionally append `pdf` to also generate a PDF alongside the DOCX

Examples:
- `/format-resume 20260302-default-cto.md`
- `/format-resume 20260302-default-cto.md pdf`

## Instructions

### Step 1: Validate Input

Read the file at `output/<filename>`. Confirm it is a resume — not a cheat sheet, coaching notes, or other internal document. If the file contains session notes, scripted answers, or non-resume headers, stop and ask for the correct file.

### Step 2: Pre-flight Checks

Before generating, scan the markdown for known formatting issues and report them:

1. **Continuation lines** — lines indented with 2+ spaces should join their parent bullet. If any are missing the 2-space indent, warn the user that they may appear as broken lines in the output.
2. **Sections** — confirm the file has four `---` dividers separating: header block / summary / competencies / experience+education.
3. **Bullet character** — bullets must use the `·` middle dot (U+00B7). Flag any `-` or `*` bullets — they will not render with the correct hanging indent style.
4. **Page estimate** — count total lines to estimate whether the output is likely to exceed 2 pages. Flag if at risk.

### Step 3: Generate DOCX

Run the DOCX generation script:

```bash
python tools/md_to_docx.py output/<filename> output/<basename>.docx
```

Confirm success from the script output.

### Step 4: Generate PDF (if requested)

If `pdf` was included in the arguments, also run:

```bash
python tools/md_to_pdf.py output/<filename> output/<basename>.pdf
```

Confirm success.

### Step 5: Report Output

Return a summary:

```
Generated:
  output/<basename>.docx   ✓
  output/<basename>.pdf    ✓ (if requested)

Pre-flight notes:
  [any warnings from Step 2, or "None" if clean]

Formatting rules applied:
  · Single column, Calibri throughout
  · Dark navy headings only — one accent color
  · Bold on role titles and company names only
  · Job blocks kept together — no splits across pages
  · 2-page maximum enforced
```

### Step 6: Tuning (if output exceeds 2 pages)

If the script output or user feedback indicates the document exceeds 2 pages, open `tools/md_to_docx.py` and reduce the spacing/size constants in this order (stop as soon as it fits):

1. `BULLET_SPACE` — reduce from current value toward 0
2. `DESC_AFTER` — reduce from current value toward 1
3. `ROLE_BEFORE` — reduce from current value toward 4
4. `BODY_PT` / `BULLET_PT` — reduce by 0.5pt increments, minimum 8.5pt
5. `MARGIN_IN` — reduce by 0.05" increments, minimum 0.55"

Never reduce `NAME_PT` below 16 or `SECTION_HDR_PT` below 9.5. Never remove bullets or content to fit the page limit — spacing and size only.

After each adjustment, re-run the script and check again.
