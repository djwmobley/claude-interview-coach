---
name: import-cv
description: Import an existing CV into structured data files (additive merge with existing data, can be run repeatedly)
argument-hint: <path-to-cv-or-paste>
user-invocable: true
allowed-tools: Read(*), Glob(*), Grep(*), Write(data/**), Edit(data/**)
---

# Import CV: Extract and Merge CV Data into Structured Files

Import professional experience from an existing CV (PDF, markdown, or pasted text) into the repository's structured data files. Designed to be run multiple times: each import **merges** with existing data rather than overwriting it.

## Core Principle: Additive Merge

This skill never destroys data. When run against a repository that already has data files:

- **New data gets added**: new projects, skills, certifications get created
- **Existing data gets enriched**: missing fields filled in, thin descriptions expanded
- **Nothing gets deleted**: a project from a previous import that isn't on the new CV stays untouched
- **User-edited content is preserved**: if a TODO marker was replaced with real content, don't overwrite it with a new TODO

This means a user can safely import an old 2018 CV first, then a newer 2024 CV, and the data accumulates correctly.

## Arguments

- `$ARGUMENTS` (optional): Path to a CV file (PDF, `.md`, or `.txt`). If omitted or "paste", ask the user to paste their CV text into the conversation.

## Instructions

### Step 1: Parse Input

1. **If `$ARGUMENTS` is a file path:**
   - Check if the file exists. If not, also check under `files/` (the convention for dropped input files).
   - Read the file. For PDFs, use the Read tool (it handles PDFs natively). For large PDFs (>10 pages), read in page chunks.
   - Store the content as `CV_TEXT`.

2. **If `$ARGUMENTS` is empty or "paste":**
   - Ask the user to paste their CV text.
   - Wait for the response and store as `CV_TEXT`.

3. **Detect language:** Scan section headers and body text. Common header patterns: English: "Summary", "Experience", "Projects", "Skills", "Education"; German: "Kurzprofil", "Berufserfahrung", "Projekterfahrung", "Fachkenntnisse", "Ausbildung"; French: "Compétences", "Expérience", "Formation"; Dutch: "Vaardigheden", "Werkervaring", "Opleiding"; Spanish: "Habilidades", "Experiencia", "Formación"; other languages: infer from content. Note the language for later use but don't block on it.

### Step 2: Load Existing Data

Read all current data files to establish the merge baseline. Read these in parallel:

- `data/profile.md`
- `data/skills.md`
- `data/certifications.md`
- `data/education.md`
- `data/companies.md`
- `data/project-index.md`
- All files in `data/projects/*.md`

If files don't exist (first run on a clean repo), that's fine: start from empty for those sections.

### Step 3: Extract and Merge

Parse `CV_TEXT` and merge with existing data for each file type below. For every field, apply the merge rule: **new data fills gaps, enriches thin content, and never overwrites user-edited content.**

#### 3a: Profile (`data/profile.md`)

Extract and merge into this structure:

```markdown
# Profile

- **Name:** [full name including academic titles]
- **Born:** [date/location if available]
- **Title:** [professional title/headline]
- **Company:** [own company, if applicable]
- **Address:** [if available]
- **Mobile:** [if available, or <!-- TODO: Add phone number -->]
- **E-Mail:** [if available, or <!-- TODO: Add email -->]
<!-- If the CV indicates freelance/self-employed status, add: -->
<!-- - **Independent since:** [year] -->

## Compensation
<!-- TODO: Add your compensation structure. Rarely on CVs: fill this in manually.
Use whichever section applies:

### Freelance / Contract
- **Daily:** [currency]XXX
- **Hourly:** [currency]XXX

### Employment
- **Salary expectation:** [currency]XXX,XXX/year
-->

## Languages
- **[Language]:** [Proficiency level]

## Availability
<!-- TODO: Describe your availability and work model preference -->
```

**Merge rules:**
- If profile.md already exists with real content in a field, keep it
- If profile.md has a TODO and the CV provides the data, replace the TODO
- If profile.md doesn't exist, create it with what the CV provides + TODOs for the rest
- Compensation and availability are almost never on CVs: create TODO sections unless they're already filled in

#### 3b: Skills (`data/skills.md`)

Extract skills and group by category using this table format:

```markdown
# Skills

## [Category Name]

| Skill | Experience | Self-Rating |
|---|---|---|
| [Skill] | [X+ years] | [Expert/Advanced/Intermediate] |
```

**Categories** (adjust to match the candidate's actual skill domains: these are suggestions):
- Cloud & Infrastructure
- Development: Backend
- Development: Frontend
- Data
- DevOps & Tooling
- Soft Skills & Methods
- [Domain-specific, e.g., "Healthcare", "Finance & Banking", "Design & UX"]

**Merge rules:**
- Add new skills not already in the file
- If a skill already exists with a higher experience level, keep the higher one
- If the CV shows more years than the existing entry, update the years
- If Self-Rating is `N/A` (unrated) and the CV doesn't provide a rating, leave it as `N/A`
- Never remove a skill that exists in the file but isn't on the new CV

**Experience estimation:** If the CV doesn't list years per skill but does list project dates, estimate experience from the span of projects using that skill. Mark estimates: `3+ years <!-- estimated from project dates -->`.

#### 3c: Certifications (`data/certifications.md`)

Extract into the table format grouped by vendor:

```markdown
# Certifications

## [Vendor Name]

| Certification | Exam Code | Earned | Expires | Status |
|---|---|---|---|---|
| [Name] | [Code] | [Date] | [Date] | [Status] |
```

**Merge rules:**
- Add new certifications not already listed
- If a cert already exists, update fields that are missing (e.g., add an expiry date)
- Never remove an existing certification
- If dates are missing from the CV, use `<!-- TODO: Add date -->`
- If no certifications are found and the file doesn't exist, create it with a placeholder:

```markdown
# Certifications

<!-- No certifications found in the imported CV. Add yours here:

## Vendor Name
| Certification | Exam Code | Earned | Expires | Status |
|---|---|---|---|---|
| Cert Name | CODE | DD Mon YYYY | DD Mon YYYY | Active |
-->
```

#### 3d: Education (`data/education.md`)

Extract into the structured format:

```markdown
## [Degree Name]

- **Institution:** [name]
- **Period:** [03/2019 – 09/2021]
- **Final grade:** [if available]
- **Majors:** [if available]
- **Thesis:** [if available]
```

For non-English degrees, add English equivalents in parentheses. Research the degree system of the candidate's country to provide accurate equivalencies: e.g. German "Diplom [Subject] (Master's equiv.)", French "Licence (Bachelor's equiv.)", Dutch "Doctoraal (Master's equiv.)", Japanese "学士 Gakushi (Bachelor's equiv.)".

**Merge rules:**
- Add new education entries not already listed (match by institution + degree)
- Enrich existing entries with missing fields
- Never remove existing entries

#### 3e: Companies (`data/companies.md`)

Only relevant if the CV indicates freelance/self-employed status, own business entities, or founding/co-founding a company.

```markdown
## [Company Name]

- **Type:** [LLC / Inc. / Ltd / GmbH / BV / Pty Ltd / S.A. / Sole Trader / etc.]
- **Period:** [Founded YYYY; active or liquidated]
- **Location:** [Country/city]
- **Purpose:** [one sentence]
```

**Merge rules:**
- Add new companies not already listed
- Enrich existing entries
- If self-employed status is clear but no company details on CV, create a TODO entry

#### 3f: Projects (`data/projects/*.md`)

This is the most important extraction. For each engagement/project on the CV, create or enrich a project file.

**File naming:** Slug from client name or project name: lowercase, hyphens for spaces, no special characters. Examples: `acme-corp.md`, `flagship-project.md`, `summer-internship.md`.

**Target structure per file:**

```markdown
# [Project Title]

- **Period:** [03/2019 – 09/2021 or "ongoing"]
- **Role:** [role title(s)]
- **Client:** [client name]
- **Industry:** [industry category]
- **Location:** [Country (CODE)]
- **Type:** [flagship | consulting | contract | co-founded | internship | employment | side-project]

## Description

[1-3 paragraphs]

## Responsibilities

- [bullet points]

## Key Achievements

- [bullet points, or TODO if not extractable]

## Technologies

[comma-separated list]

## Tags

[lowercase, hyphenated tags]
```

**Type classification:**
- External consultant/advisor → `consulting`
- Specific contract/project work → `contract`
- Permanent or full-time employment → `employment`
- Co-founded or CEO/founder → `co-founded`
- Explicitly an internship → `internship`
- Personal/hobby/side venture → `side-project`

> **Note:** `flagship` is also a valid type (the candidate's single most significant role: typically multi-year, high-impact, central to professional identity), but **never auto-assign it during import**. Only the candidate can decide which project (if any) deserves this label. Mention it in Next Steps instead.

**Merge rules: the key logic:**
- **Match existing projects by client name + overlapping period.** If a project file already exists for the same client and the periods overlap, this is the same project: enrich it.
- **Enriching means:** add missing responsibilities, fill in blank descriptions, add technologies the CV mentions that the file doesn't have, update tags. Never remove content that's already there.
- **New projects** (no matching file) get a new file created.
- **Projects in existing files but not on this CV** are left completely untouched: they came from a previous import or were added manually.
- **Key Achievements** are rarely on CVs in detail. If the file already has achievements, keep them. If not, add a TODO:

```markdown
## Key Achievements

<!-- TODO: Add 2-3 key achievements. Think about:
- What measurable impact did you have?
- What problems did you solve?
- What would have happened without you?
-->
```

#### 3g: Project Index (`data/project-index.md`)

**Regenerate entirely** from all project files (both existing and newly created). Read every file in `data/projects/` and compile the index in reverse-chronological order.

```markdown
# Project Index

> Overview of all projects. For full details, see individual files in `data/projects/`.

## [filename].md
- **Period:** [from project file]
- **Role:** [from project file]
- **Client:** [from project file]
- **Industry:** [from project file]
- **Location:** [from project file]
- **Type:** [from project file]
- **Technologies:** [from project file]
- **Tags:** [from project file]
```

This is the one file that gets fully rewritten (not merged) because it's derived entirely from the project files.

### Step 4: Write Files

Write all merged files. Go through them in this order:

1. `data/profile.md`
2. `data/skills.md`
3. `data/certifications.md`
4. `data/education.md`
5. `data/companies.md` (if applicable)
6. Each `data/projects/<slug>.md` (new or enriched)
7. `data/project-index.md` (regenerated)

For files that already exist and are being enriched, use Edit where surgical changes suffice, or Write for larger rewrites. For new files, use Write.

### Step 5: Report

After all files are written, present a summary:

```markdown
## Import Complete

**Source:** [filename or "pasted text"] ([language detected])

### Changes
- **Profile:** [created | updated N fields | unchanged]
- **Skills:** [N new skills added, M updated | file created with N skills]
- **Certifications:** [N new certs added | file created with N certs | no certs found]
- **Education:** [N entries added | unchanged]
- **Companies:** [N entries added | skipped (not freelancer) | unchanged]
- **Projects:** [N new projects created, M existing projects enriched]
- **Project index:** Regenerated ([total] projects)

### TODO Items
[count] items need manual attention:
- `data/profile.md`: compensation, availability
- `data/projects/[name].md`: key achievements (×N projects)
- [etc.]

### Next Steps
- Fill in TODO items (highest impact: compensation and key achievements)
- Review your projects: if one stands out as your anchor (multi-year, high-impact, central to your identity), mark its type as `flagship`
- Import another CV to enrich further: `/onboard path/to/another-cv.pdf`
- Discover your professional identity: `/extract-identity`
- Generate your first CV: paste a job ad and ask for a targeted resume
```
