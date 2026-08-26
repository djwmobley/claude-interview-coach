# /menu

Display all available commands, organized by workflow stage.

## What to do

Print the following reference. No file I/O needed.

---

## AI Interview Coach — Command Reference

### Stage 1: Getting Started

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/import-cv` | `<file-path or paste CV text>` | Import an existing CV into structured data files. Can be run repeatedly; merges additively. |
| `/extract-identity` | *(none)* | Guided coaching conversation to discover professional identity, strengths, values, and narrative patterns. Produces `data/professional-identity.md`. |

### Stage 2: Applying for Roles

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/write-resume` | `<job-ad-url or paste job description>` | Generate a targeted, ATS-optimised resume. Produces markdown and DOCX. |
| `/write-cover-letter` | `<job-ad-url or paste job description>` | Write a targeted cover letter in your voice. Produces DOCX. |
| `/scan-jobs` | `<portal domain> [search terms]` | Scan a job portal for matching roles with fit scoring. Tracks evaluated ads. |

### Stage 3: Gap Analysis and Learning

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/skill-gap` | `<job-ad-url or paste job description>` | Identify skill gaps against a target role, find learning resources, generate a tracked learning plan. |
| `/learn-today` | `[done] [quiz]` | Show today's learning module. Add `done` to log completion. Add `quiz` to test yourself on completed material. |

### Stage 4: Interview Preparation

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/research-company` | `<company-url> [job-ad-url]` | Run a parallel agent fleet to produce a full interview intelligence brief: company situation, key people with approach notes, proof points mapped to the role, DO/DO NOT pressure point responses, scripted openers, and a 60-second pre-call checklist. Saves a styled HTML file to `output/research/`. |
| `/voice-export` | `<cv-path> <job-ad-url>` | Generate a self-contained recruiter simulation prompt for the Claude App (voice mode practice). |
| `/debrief` | `<cv-path>` | Analyze a voice simulation transcript, identify anti-patterns, log the session to progress tracking. |

### Stage 5: Quality Review

| Command | Arguments | Purpose |
|---------|-----------|---------|
| `/review-cv` | *(run after /write-resume)* | Fast quality-gate review of a generated CV against its target role. |
| `/review-cv-deep` | *(run after /write-resume)* | Multi-perspective deep-dive review: recruiter, hiring manager, competitor, skeptic, copy editor, source data auditor. |

---

**First time here?** Start with `/import-cv` to load your professional history, then `/extract-identity` to build your professional identity profile.
