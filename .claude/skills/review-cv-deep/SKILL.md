---
name: review-cv-deep
description: Multi-perspective deep-dive CV review (recruiter, hiring manager, competitor, skeptic, copy editor, source data auditor)
argument-hint: <path-to-cv> <job-ad-url-or-path> [intermediary-name]
user-invocable: true
allowed-tools: Read(*), Glob(*), Grep(*), Write(output/**), Task, WebFetch, WebSearch
---

# Review CV Deep: Multi-Perspective Analysis

Run a comprehensive, multi-perspective review of a generated CV by simulating how different stakeholders would read it. This is a thorough analysis that takes several minutes and produces an actionable report with severity-rated issues and specific rewrites.

Use this for important applications where the stakes justify the time, or when the fast `/review-cv` gate has passed but you want to pressure-test the CV before submission.

## Arguments

- `$ARGUMENTS` (required): Two arguments:
  1. **CV filename**: just the filename (e.g., `20260209-draft.md`). The file is always read from the `output/` folder. Must be an actual CV/resume, not a cheat sheet or internal document.
  2. **Job ad**: either a URL to the job posting (e.g., upwork.com link) or a path to a local file containing the job description
- The intermediary/agency name is extracted from the job ad automatically (no need to supply it separately)
- Examples:
  - `/review-cv-deep 20260209-draft.md https://www.upwork.com/project/example-id123`
  - `/review-cv-deep 20260209-draft.md data/job-posting.txt`

## Instructions

### Step 1: Validate Input and Load All Context

**Input validation (mandatory):** Before doing anything else, read the CV file and verify it is an actual CV/resume: not a cheat sheet, coaching notes, or other internal preparation document. A valid CV will have standard professional sections such as a profile/summary, work experience/projects, skills/competencies, and education/certifications (in any language). If the file contains any of the following, **STOP and ask the user for the actual CV file**:
- Tactical call notes (e.g., "Don't mention proactively", "Don't say", "If pushed back on": in any language)
- Scripted answers or rate negotiation scripts
- Internal background research on the client/intermediary
- Section headers indicating call preparation rather than CV content (e.g., "Cheat Sheet", "Answers for the Call", "Tactical Questions": in any language)

These are internal documents that must NEVER be passed to review agents simulating external stakeholders (recruiters, hiring managers). The review must be based on what the external party actually sees: the CV.

**If the job ad is a URL**, fetch it using WebFetch to extract the full job posting text.

After validation passes, read the following files in parallel:

1. The validated CV file (at `output/<filename>`)
2. `data/project-index.md`: to identify which source project file paths correspond to the projects listed in the CV

From the project-index, compile the list of source project file paths (e.g., `data/projects/flagship-project.md`, `data/projects/client-a-project.md`) that the CV references. These paths will be routed to the Source Data Auditor agent in Step 3: the orchestrator does NOT read these files itself.

### Step 2: Extract Role Profile

From the job posting, extract:
- **Primary skills** (the 3-5 technologies/competencies that are non-negotiable)
- **Secondary skills** (nice-to-haves)
- **Seniority level** and likely team structure
- **Industry and market** (derive the target geography and engagement model from the job posting)
- **Intermediary/agency**: extract from the job ad (company name, their role in the hiring chain)
- **The likely competition**: what kind of candidates will also apply? (e.g., for a role requiring a specific product, expect dedicated specialists with 5+ years)

### Step 3: Launch Six Parallel Reviews

Use the Task tool to launch **six parallel subagents** (subagent_type: `general-purpose`), each adopting a different perspective.

**Context strategy: differentiated by perspective:**

Perspectives 1-5 simulate external readers who only see the CV. Perspective 6 is an internal quality check with backstage access.

| Perspective | Include in prompt | Agent reads |
|---|---|---|
| 1. Recruiter | Job posting text, intermediary name | CV file only |
| 2. Hiring Manager | Job posting text | CV file only |
| 3. Competitor | Job posting text, primary/secondary skills | CV file only |
| 4. Skeptic | Job posting text | CV file only |
| 5. Copy Editor | Job posting text, target market | CV file only |
| 6. Source Data Auditor | Job posting text, list of source file paths | CV + source project files + `data/certifications.md` |

- Tell each agent to read the CV file using its **absolute path** (the same absolute path the orchestrator used in Step 1, e.g., `output/20260209-draft.md`). The Read tool requires absolute paths: relative paths will fail silently and cause agents to return empty results.
- **Do include** in the prompt: the extracted job posting text and the role profile from Step 2
- **Do NOT include** any internal documents (cheat sheets, coaching notes, rate scripts) in any agent prompt
- **Do NOT include** professional-identity data, underselling patterns, or pre-digested findings in any agent prompt: the review is a pure external-eyes assessment
- **Only the Source Data Auditor** (Perspective 6) gets the list of source project file paths. Provide all file paths as **absolute paths**. All other agents work from the CV alone.
- **Set `max_turns` to at least 10** for each agent to ensure they have enough turns to read files and produce their full assessment.

#### Perspective 1: Recruiter / Agency Filter

Persona: Technical recruiter at the intermediary/agency identified from the job ad, doing an initial CV screen. The recruiter's decision at this stage is **whether to invite the candidate to a phone screening**: NOT whether to forward to the end client. The forward decision comes after the phone call. This means the bar is lower: the CV needs to earn 15 minutes on the phone, not survive full due diligence.

Assess:
- **ATS keyword matching**: would this CV survive automated keyword filters for the role title? List every primary keyword from the posting and whether it appears in the CV. Pay special attention to product-specific terms (variant names vs. parent product names).
- **Screening invite signals**: does the CV hit enough must-have keywords, certifications, seniority level, rate ballpark, and availability to justify a 15-minute call? What stands out positively at first glance?
- **Red flags and hesitations**: what would make the recruiter hesitate before scheduling a call? Focus on CV-surface concerns: missing primary keywords, location/timezone friction, rate mismatch, confusing timeline, unclear role titles. Do NOT over-weight concerns that would only surface in a phone call (team fit, commitment level, engagement-model concerns); those are for the call itself, not the CV screen.
- **Timeline analysis**: gaps, overlaps, confusing chronology. Calculate the actual timeline and flag anything that doesn't add up.
- **Length and format**: appropriate for this seniority level and market?
- **Phone screening invite decision**: clear yes/no/maybe with reasoning. The question is: "Would I spend 15 minutes on the phone with this person?" rather than "Would I forward them to the client?"

#### Perspective 2: End Customer / Hiring Manager

Persona: Engineering manager at the end client, hiring for their team. Adopt the cultural context matching the role's geography (e.g., US hiring norms for US-based roles, DACH conventions for German/Austrian/Swiss roles, UK conventions for UK roles, etc.). Derive the appropriate context from the job posting's location and language.

Assess:
- **Cultural/contextual confusion**: what looks unfamiliar from a different market? (e.g., non-local degree formats, unfamiliar grading scales, freelancer vs. employee framing, terminology differences, derive from the candidate's `data/profile.md` location vs. the target market)
- **Claim validation concerns**: what claims seem inflated or vague? Where does the hiring manager wonder "what did YOU actually do vs. the team?"
- **Primary skill depth**: how confident is the hiring manager that this person can deliver on the core requirement? (e.g., if the role requires a specific product variant, distinguish between related-but-different experience explicitly)
- **Team fit signals**: does the CV suggest someone who can collaborate, accept direction, and work within existing processes?
- **Interview decision**: yes/no/maybe with reasoning.

#### Perspective 3: Competitor Candidate Comparison

Persona: Hiring consultant comparing shortlisted candidates.

Assess:
- **Where this CV is weaker** than dedicated specialists in the primary skill area. List specific competencies that are missing or thin.
- **Where this CV is stronger** than pure specialists. What does this candidate bring that a typical specialist wouldn't?
- **The unique selling proposition**: what's the pitch for choosing this candidate?
- **What tips the scales**: under what role conditions does this candidate win vs. lose?
- **Competitive positioning advice**: how should the CV be repositioned?

#### Perspective 4: Skeptic / Devil's Advocate

Persona: Thorough technical interviewer reading this CV cold with maximum skepticism. You have NO access to source project files: only the CV and the job posting. Your job is to flag everything that looks suspicious from the text alone.

Assess:
- **Timeline issues**: overlaps between concurrent engagements, gaps, vague dates. If a project is listed as "ongoing" alongside other engagements, flag it.
- **Role title vs. actual work**: where do titles seem inflated relative to the described responsibilities? Where is there a gap between the title and what's actually described?
- **Technologies listed but not evidenced**: skills in the skills/competencies table that don't appear substantively in any project description. Experience years that seem implausible given the project timeline.
- **Vague or inflated claims**: probe any superlatives, scale numbers, or impressive-sounding claims that aren't substantiated with specifics.
- **Certification vs. role mismatch**: are the certifications relevant to the target role? Are there missing certifications the role would expect? Any certifications with qualification notes (pending, expired)?
- **Top 10 probing interview questions** this CV would generate: questions that would force the candidate to be precise about vague claims.

#### Perspective 5: Copy Editor / Professional Presentation

Persona: Professional CV editor reviewing for polish.

Assess:
- **Formatting consistency**: project header patterns, date formats, technology list formats, bullet point bold labels.
- **Language and tense**: British vs. American consistency, tense correctness (present for ongoing, past for completed), first/third person consistency.
- **Awkward phrasing**: native-language calques (derive the candidate's native language from `data/profile.md`), informal language, cliches, sentence fragments, corporate-speak.
- **Visual balance**: are sections proportionally detailed? Are any sections too thin or too dense?
- **Header hierarchy**: consistent heading levels, no unusual prefixes.
- **Missing elements**: availability, links, other standard CV components for the target market.
- **Line-level issues** with specific line references and suggested rewrites.

#### Perspective 6: Source Data Auditor

Persona: Internal quality reviewer with full backstage access. You are NOT simulating an external reader: you are verifying the CV's accuracy and completeness against the candidate's actual project documentation.

Read the CV AND all the source project files listed in your prompt, plus `data/certifications.md`. Then autonomously cross-reference:

- **Factual accuracy**: Do experience years, scale numbers, technology claims, and role descriptions on the CV match what the source project files document? Flag every discrepancy.
- **Role title inflation**: Do CV role titles match what the source project files describe? (e.g., did a role start as one thing and evolve, but the CV only shows the final title?)
- **Missed high-value content**: What's in the source files that should be on the CV but isn't? Focus especially on content relevant to the target role. List specific achievements, technologies, or responsibilities that are documented in the source but absent from the CV.
- **Certification status**: Are certifications listed accurately? Cross-reference each one against `data/certifications.md`. Flag any that are expired or renewal-pending but listed without qualification on the CV.
- **Technology evidence gaps**: For each technology in the CV's skills table, check whether the source project files substantiate the claimed experience level and years.

Output your findings as a structured list of factual issues and missed opportunities, each with specific references to both the CV line/section and the source file that contradicts or supplements it.

### Step 4: Compile Consolidated Report

After all six agents return, synthesise their findings into a single report with this structure:

```markdown
# CV Deep Review: [CV filename]

**Target role:** [role title]
**Intermediary:** [if provided]
**Date:** [today]

## Verdict Summary

| Perspective | Verdict | One-Line Summary |
|---|---|---|
| Recruiter (phone invite?) | Yes/No/Maybe | ... |
| Hiring Manager (interview?) | Yes/No/Maybe | ... |
| Competitor Comparison | Wins if.../Loses if... | ... |
| Skeptic | N critical concerns | ... |
| Copy Editor | N issues found | ... |
| Source Data Auditor | N factual issues / N missed opportunities | ... |

## Severity-Rated Issue List

### CRITICAL
| # | Issue | Perspectives | Lines | Detail |
|---|---|---|---|---|

### IMPORTANT
[same format]

### MINOR
[same format]

### NITPICK
[same format]

## Key Suggested Rewrites
[Specific line references with before/after text for the most impactful changes]

## Top 10 Probing Interview Questions to Prepare For
[From the skeptic perspective]

## Top 5 Highest-Impact Changes
| Priority | Change | Why | Effort |
|---|---|---|---|
[Ranked by impact-to-effort ratio]

---

## Appendix: Raw Agent Outputs

### A1. Recruiter / Agency Filter
[Full unedited output from Perspective 1 agent]

### A2. End Customer / Hiring Manager
[Full unedited output from Perspective 2 agent]

### A3. Competitor Candidate Comparison
[Full unedited output from Perspective 3 agent]

### A4. Skeptic / Devil's Advocate
[Full unedited output from Perspective 4 agent]

### A5. Copy Editor / Professional Presentation
[Full unedited output from Perspective 5 agent]

### A6. Source Data Auditor
[Full unedited output from Perspective 6 agent]
```

**Important:** The appendix must contain the **complete, unedited output** from each agent: do not summarize, truncate, or reformat. This preserves the full reasoning and detail for later reference, even when findings have been merged or de-duplicated in the consolidated sections above.

### Step 5: Deduplication and Severity Alignment

When multiple perspectives flag the same underlying issue:
- **Merge into a single entry** with all flagging perspectives listed.
- **Use the highest severity** assigned by any perspective.
- **Combine the detail** from all perspectives for a richer description.

**Skeptic + Auditor overlap:** When the Skeptic flags something as suspicious from the CV surface and the Source Data Auditor confirms or refutes it against source data, merge into one entry with both perspectives listed. The Auditor's factual detail enriches the Skeptic's suspicion-based finding.

### Severity Definitions

- **CRITICAL:** Would likely cause the CV to be rejected, filtered out, or create a seriously misleading impression. Must fix before submission.
- **IMPORTANT:** Weakens the CV meaningfully or raises a question the candidate should have pre-empted. Should fix.
- **MINOR:** Noticeable imperfection that doesn't change the outcome but reduces polish. Nice to fix.
- **NITPICK:** Stylistic preference or extremely minor inconsistency. Fix if time permits.

### Step 6: Save Report

Save the consolidated report to the `output/` folder using the CV filename with `-DEEP-REVIEW` appended before the extension:

- CV: `output/20260210-target-role-slug.md`
- Report: `output/20260210-target-role-slug-DEEP-REVIEW.md`

This naming convention is required so that other skills (e.g., `/voice-export`) can auto-detect the deep review file.
