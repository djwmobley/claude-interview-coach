---
name: write-resume
description: Write a targeted resume for a specific role, reads all source data, tailors content, generates markdown and DOCX
argument-hint: <job-ad-url-or-file-or-paste-or-listing-id> [application:<id>]
user-invocable: true
allowed-tools: Read(*), Write(*), Edit(*), Glob(*), WebFetch, mcp__job-search__get_job, mcp__job-search__render_doc
---

# Write Resume

Produce a tailored resume for a specific role. Reads all candidate source data,
analyses the job posting, writes the resume, generates DOCX, and produces a
recruiter call cheat sheet.

## Arguments

- `$ARGUMENTS` (required): The target role: one of:
  - A numeric job-search dashboard listing id (e.g. `1234`), from the apply
    pipeline's "Create application" card or `/write-resume 1234` copy button.
    Call the job-search MCP `get_job` tool with that id for the url, company,
    and stored description. Never re-fetch the posting with WebFetch when an
    id is given: `get_job` already returns the description the dashboard
    stored at scan time. Pass this same id through to `render_doc` as
    `listingId` in Step 7 and Step 8 (see NON-NEGOTIABLE RULES > Output
    Requirements) so the rendered DOCX links to the listing's application.
  - A URL to a live job posting
  - A file path to a saved job description
  - A pasted job description (if no argument, ask the candidate to paste it)
- `application:<id>` (optional, appended after the listing id, e.g. `5871 application:42`):
  present ONLY on a one-click apply / headless run kicked off by the dashboard's
  Apply button. Presence of this token puts the skill in **headless mode** (see
  below). Absent on every normal interactive invocation.

---

## HEADLESS MODE

Triggered ONLY when `$ARGUMENTS` carries `application:<id>`. This is an
unattended run: the caller (the dashboard's one-click apply chain) is not a
person who can answer a question.

**MUST NOT ask the user anything in this mode.** Every place elsewhere in this
skill that says "ask the candidate," "stop here and ask," or similar does not
apply in headless mode. There is no one to ask.

- If `get_job`'s returned `description` is missing or shorter than 300
  characters: do NOT draft anything. Output the single line
  `HEADLESS_ABORT: no_description` and stop immediately. No markdown file, no
  render_doc call.
- Never second-guess fit or role match in headless mode. The caller already
  decided to apply (the Apply click, or an auto-apply rule) before this skill
  ever ran; re-litigating "is this the right role" here is out of scope and
  must not block the draft.
- Proceed through Step 7's `render_doc` call passing BOTH `listingId` AND
  `applicationId` (the id from the `application:<id>` token) on every
  `render_doc` call in this run, not just the final render.
- On any other unrecoverable condition (a `render_doc` check that cannot be
  fixed without asking the candidate something only they would know, a
  `LOCKED`/`EXISTS` DOCX conflict, or any other dead end): output the single
  line `HEADLESS_ABORT: <snake_case_reason>` (a short, specific reason, e.g.
  `HEADLESS_ABORT: docx_locked`) and stop. Never guess an answer that would
  normally require asking the candidate.
- Every other rule in this file (role inclusion, format, writing rules,
  output requirements) still applies in headless mode: headless changes only
  who gets asked what, never the quality bar.

---

## NON-NEGOTIABLE RULES

These rules override all judgment calls. They are not guidelines.

### Scope: Resume Only

**This skill produces a resume and cheat sheet. Nothing else.**

- Do NOT auto-generate a cover letter. Cover letters are only produced when the
  candidate explicitly invokes `/write-cover-letter` or says "write me a cover letter."
- Do NOT auto-generate a LinkedIn InMessage or any other outreach text. These are
  only produced when explicitly requested.
- "Apply for it" or "I'll apply" means: write the resume. That is all.
- If the candidate separately asks for a cover letter or InMessage in the same
  request, hand off to `/write-cover-letter` for those, do not fold them into
  this skill's output.

### Role Inclusion

**Every role in `data/project-index.md` MUST appear in the resume unless the
candidate has explicitly said to omit it in this session.**

Do not remove roles for any of these reasons:
- You judged the role as "not relevant enough"
- The role was short
- The role seems to duplicate another role's story
- The role was at a lower level than the target

If you believe a role adds little value, you may write fewer bullets for it,
but it must appear. Gaps between listed roles will be noticed by recruiters.

**Before writing the resume**, list every role from `data/project-index.md` and
confirm all are included in your plan. If you are omitting any, state it
explicitly and ask for permission first.

### Format

The markdown output MUST follow the md_to_docx.py format exactly or the
converter will break. See the format spec in MEMORY.md and the reference
file `output/markdown/20260302-default-cto.md`.

- **Block 0:** Name / contact / tagline (| separators). No `#` prefix on name.
- **Block 1 (after first ---):** Summary paragraphs. No `##` heading.
- **Block 2 (after second ---):** Competencies, `·` separated. No `##` heading.
- **Block 3+ (after third ---):** Body. ALL CAPS section labels. Role title on
  its own line. `Company | City, ST | 2019 – 2021` pipe line below role.
  Description line. Bullets use `·` (middle dot). 2-space indent on continuation
  lines. Jobs separated by blank lines only, NO `---` between jobs.
  One final `---` before EDUCATION/CERTIFICATIONS.

### Writing Rules (zero exceptions)

- **No em-dashes anywhere.** Use commas, semicolons, colons, or periods instead.
- **No scare quotes around individual words.** Quoting a single word for emphasis
  or distance ("overseeing", "transformation", "alignment") is an AI writing tell.
  Rewrite the sentence or use the word plainly.
- **No AI buzzwords:** spearheaded, leveraged, championed, harnessed, utilized,
  orchestrated, revolutionized, transformative, cutting-edge, game-changing,
  robust, seamless, synergies, unlock. If you find yourself writing one, stop
  and replace it.
- **No tables in the resume body.** ATS systems cannot parse them.
- **No commas in role titles.** "Director, Program Management Office" causes ATS parsers
  to split on the comma and misread the job title and company name. Use "Director of Program
  Management" or rephrase to remove the comma entirely.
- **Year-only dates** on all roles (not month-year).
- **Named platforms in experience bullets only**: not in the summary or
  competencies section. Summary must stay platform-agnostic.
- **Revenue framing:** use "supported" not "drove": technology enables revenue,
  it doesn't cause it.
- **Payment specifics:** percentage improvements only, never baseline numbers
  (those figures are commercially privileged).
- **No weakness admissions.** Never write: "currently expanding", "basic
  knowledge of", "evaluated but not used". If a skill isn't strong enough to
  state positively, omit it.
- **No expired certifications listed as active.** Check `data/certifications.md`.
  If a cert is expired, either omit it or note it as expired, never imply it
  is current.

### Formatting Standards (enforced by md_to_docx.py)

These are produced automatically by the converter, but content decisions must
respect them:

- **Heading centered:** Name, contact line, and tagline are center-aligned.
- **Consistent font:** Calibri throughout: no font variation.
- **Body text is 10pt; the name is 18pt** as a title treatment. Do not add
  markup that would create a different size range.
- **Bullets render as real Word list items** (List Bullet style), not a
  typed middle-dot glyph inside a plain paragraph. Keep writing the `·`
  prefix in the markdown source; the converter strips it and applies the
  real bullet formatting.
- **Target 2 pages, 3 is acceptable.** Page count is not tuned: never cut
  content, and never reduce bullets, to make a draft fit a page count.
- **Jobs do not split across pages.** The converter uses keep-with-next
  chaining to hold each job block together. EDUCATION and CERTIFICATIONS are
  kept together the same way whenever EDUCATION has no bullets of its own.

### Output Requirements

**Always generate both outputs before telling the candidate the resume is ready:**

1. Markdown file at `output/markdown/YYYYMMDD-[slug].md`
2. DOCX file at `output/resumes/<outName>.docx`, rendered by the `render_doc`
   MCP tool, never by running the Python converter or grep by hand.

`render_doc` enforces every writing and format rule above mechanically
(em-dash, en-dash outside year ranges, scare quotes, buzzwords, the
problem-comparison reframe, md_to_docx.py block structure, role inclusion
against `data/project-index.md`, PMP wording, Jenkon title, output naming).
The rules still apply while drafting; the tool is the gate, not a substitute
for writing them right the first time.

**Output naming:** the DOCX gets a human name (`outName`), for example
`Jordan Reyes - CTO`. Datestamped slugs are refused for resumes. Never
include the `.docx` extension in `outName`.

**Never deliver a resume as markdown only.** The candidate reviews layout in
the DOCX, not the source file. Never open the DOCX after rendering; the
candidate opens it himself (auto-opening causes file locks on the next
regeneration).

**Locked or existing DOCX:** if `render_doc` returns `LOCKED`, the DOCX is open
in Word. Ask whether to close it (then call again) or to edit the document
directly. Never regenerate over a hand-edited DOCX. If it returns `EXISTS`,
pass `force:true` only when the candidate confirms the existing file has not
been hand-edited.

---

## Instructions

### Step 1: Load Candidate Data

Read in parallel:
- `data/project-index.md`: all roles (this is your inclusion checklist)
- `data/profile.md`: contact info, compensation, availability
- `data/skills.md`: skill inventory with experience levels
- `data/certifications.md`: active and expired certifications
- `data/professional-identity.md`: narrative reframes, strengths, voice
- `data/education.md`: degrees and qualifications

Also read `memory/voice.md` if it exists, apply writing preferences and
avoidance list throughout.

Also read `output/markdown/20260302-default-cto.md` as the content baseline.
This is the audited default resume; use its bullet phrasing as the starting
point for each role rather than drafting bullets from scratch. Adapt bullets
for the target role; preserve any bullet that already maps well.

**Build a role inclusion checklist** from `data/project-index.md`. Every entry
must appear in the resume or be explicitly approved for exclusion by the
candidate.

---

### Step 2: Load the Job Posting

If `$ARGUMENTS` starts with a numeric listing id, call `get_job({id:
<listingId>})` and use its `url`, `company`, and `description` fields as the
job posting. Do not also call WebFetch on that url: `get_job` already returns
the description the dashboard stored at scan time, and re-fetching risks
pulling a page that has since changed or gone stale. Remember the listing id;
it is passed to `render_doc` as `listingId` in Step 7 and Step 8.

If `$ARGUMENTS` also contains an `application:<id>` token, this is a headless
run (see HEADLESS MODE above). Extract the application id and remember it;
apply the description-length check (>= 300 characters) immediately after this
`get_job` call and abort per HEADLESS MODE if it fails, before proceeding to
Step 3.

Otherwise: if a URL was provided, fetch it. If a file path, read it. If
neither, ask the candidate to paste the job description.

Fetch prompt:
```
Extract the complete job posting text. Include every section: title, description,
responsibilities, required qualifications, preferred qualifications, and any
stated nice-to-haves. Do not summarise, reproduce the full text.
```

---

### Step 3: Analyse the Role

Extract:
- **Top 10 keywords**: the terms most likely used in ATS screening. Write them
  down before drafting. Every keyword must appear at least once in the final CV.
- **Must-have requirements**: hard requirements that will be screened on
- **Preferred requirements**: mentioned as preferred or a plus
- **Seniority and scope indicators**: team size, budget, P&L, domain
- **Tone and language**: note the posting's vocabulary; mirror it

Check `data/plugin-activation.md` (if present) for any enabled plugins whose
scope includes `cv`: load their rules alongside these.

---

### Step 4: Plan the Resume: Declare All Inclusions/Exclusions

Before writing, state:

```
## Resume Plan

**Roles to include (all from project-index.md):**
- [Role] at [Company] (2019–2021): [1 sentence: how it maps to this role]
- [Role] at [Company] (2019–2021): [1 sentence: how it maps to this role]
...

**Order:** [explain if not strictly chronological, relevance-based reordering]

**Roles NOT included:**
- [Role] at [Company]: REASON: [explicit reason]: NEED APPROVAL

**Title line:** [proposed tagline for this application]

**Angle:** [1-2 sentences: what narrative thread ties this resume together
for this specific role]
```

If any role is in the exclusion list, **stop here and ask for approval** before
proceeding (interactive mode). In headless mode, never propose excluding a
role in the first place: include every role from `data/project-index.md` with
however few bullets it warrants, and if that is genuinely impossible for some
reason, abort with `HEADLESS_ABORT: role_inclusion_conflict` rather than
asking.

---

### Step 5: Read Relevant Project Detail Files

Read the full project files for all included roles from `data/projects/`.
Read them in parallel.

Also read `coaching/coached-answers.md` if it exists, reuse existing coached
answers for the cheat sheet rather than writing new ones from scratch.

---

### Step 6: Write the Resume

Follow the format spec in the NON-NEGOTIABLE RULES section exactly.

**Summary (Block 1):**
- Written in third-person implied (no "I")
- Speaks directly to this role's core needs
- No named platforms
- No em-dashes
- 3–5 short paragraphs or a single flowing section; keep it tight

**Competencies (Block 2):**
- Derived from the job posting's keywords and the candidate's actual skills
- Plain text with `·` separators: no bullets, no categories, no headers

**Experience bullets:**
- Order roles by relevance to this role (not necessarily chronological)
- Write 3–6 bullets per role: more for recent/flagship, fewer for older/shorter
- Lead each bullet with the action and outcome, not the task
- Connect every major bullet to something in the top 10 keyword list
- Team-fit signals: at least 2–3 collaboration references across the full resume

**Content baseline:** Start from the default resume's existing bullets and adapt
to the target role. Rewrite bullets that need re-angling; preserve those that
already land well. This keeps the polished copy consistent across all resumes
and avoids re-generating content that has already been reviewed and refined.

**After drafting**, run the pre-output checklist:

```
Pre-Output Checklist:
[ ] Top 10 keywords each appear at least once
[ ] No role from project-index.md is missing (or exclusion was approved)
[ ] No em-dashes in the entire document
[ ] No AI buzzwords
[ ] No tables
[ ] No commas in role titles (ATS parses comma as field separator, breaks job title and company)
[ ] Year-only dates on all roles
[ ] Named platforms in bullets only, not summary or competencies
[ ] No weakness admissions
[ ] Certifications are current or noted as expired
[ ] At least 2-3 collaboration/team-fit signals
[ ] All bullets contain a verb (no fragments)
[ ] Tense correct: present for ongoing, past for completed
[ ] Revenue bullets use "supported" not "drove"
[ ] Payment figures are percentages only, no baselines
[ ] Block format matches md_to_docx.py spec exactly
```

Fix any failures before proceeding.

---

### Step 7: Write Markdown File and Generate DOCX

1. Write the markdown to `output/markdown/YYYYMMDD-[role-slug].md`
2. Preflight only:
   `render_doc({kind:'resume', source:'output/markdown/YYYYMMDD-[role-slug].md', outName:'Jordan Reyes - [Title]', checkOnly:true})`
   Read `checks[]`. Fix every `fail` in the markdown (the tool reports line
   numbers) and preflight again until every check is `pass` or
   `not-applicable`. If `role_inclusion` fails for a role the candidate
   explicitly approved omitting in this session, pass
   `allowMissing:['Company']`; never pass it for a role that was not approved.
3. Render:
   `render_doc({kind:'resume', source:'output/markdown/YYYYMMDD-[role-slug].md', outName:'Jordan Reyes - [Title]'})`
   The response carries `output_path` and `bytes`. Do not open the file.
   If Step 2 used a listing id, pass it through as `listingId` on this render
   call (not on the `checkOnly` preflight call): `render_doc({kind:'resume',
   source:'output/markdown/YYYYMMDD-[role-slug].md', outName:'Jordan Reyes -
   [Title]', listingId:<listingId>})`. This links the DOCX to the listing's
   application and moves it from drafting to docs_ready. If this is a headless
   run (an `application:<id>` token was present), ALSO pass `applicationId:
   <applicationId>` on this same call: `render_doc({kind:'resume',
   source:'output/markdown/YYYYMMDD-[role-slug].md', outName:'Jordan Reyes -
   [Title]', listingId:<listingId>, applicationId:<applicationId>})`. This
   scopes the link to that specific application rather than the listing's
   most recent one. The response's `application_link` reports whether the
   link took effect; if `application_link.ignored` is true, tell the
   candidate why (the reason field) in interactive mode, or abort with
   `HEADLESS_ABORT: <reason>` in headless mode, rather than assuming the link
   happened silently.

---

### Step 8: Write the Call Cheat Sheet

Write to `output/cheatsheets/YYYYMMDD-[role-slug]-cheatsheet.md`.

Then render the DOCX with the same preflight-then-render pattern:
`render_doc({kind:'cheatsheet', source:'output/cheatsheets/YYYYMMDD-[role-slug]-cheatsheet.md', checkOnly:true})`
then, once every check passes,
`render_doc({kind:'cheatsheet', source:'output/cheatsheets/YYYYMMDD-[role-slug]-cheatsheet.md'})`.
Cheat sheets keep the datestamped slug as their file name (`outName` is optional
for this kind). The writing rules (no em-dashes, no scare quotes, no buzzwords)
apply to the cheat sheet too and the tool checks them.

**Include:**
- 15-second recruiter pitch tailored to this role
- For each must-have requirement: 2–3 specific things the candidate did (not
  generic skills, concrete actions from their projects)
- Compensation answer (salary target, bonus, equity stance)
- Availability and start date answer
- Work model answer (remote/hybrid/onsite)
- Likely pressure points for this role, with DO / DO NOT guidance
  - For each pressure point, add a **"Do NOT say:"** warning for the specific trap
- 1–2 closing questions for the recruiter (not deep technical ones: save those
  for the hiring manager)

Cross-reference `coaching/pressure-points.md` and
`framework/answering-strategies/anti-patterns.md` if they exist.

---

### Step 9: Deliver

Tell the candidate:
- DOCX path (from `render_doc` `output_path`); it is not opened automatically
- Cheat sheet path
- Brief summary of the angle taken (title line, narrative, any notable reframes)
- If any role was intentionally de-emphasized (fewer bullets), say so explicitly
