# Voice Export: Recruiter Simulation Prompt for Claude App

## Purpose

The Claude App (voice mode) has no file access. To practise recruiter screenings by voice, the candidate needs a single self-contained prompt that sets up a **realistic full simulation** -- no coaching, no interruptions, just a realistic recruiter call.

**Voice export is recruiter/HR screening only.** It simulates the first-stage phone screen, not a hiring manager technical interview. Plugins that activate only for mock interviews or full simulations do not apply here.

Coaching and debrief happen **afterwards in Claude Code**, where all context files (coached answers, anti-patterns, progress tracking) are available.

## Input

- **CV file**: a generated resume from `output/*.md`
- **Job ad URL**: the candidate provides the job ad URL

The skill auto-detects a matching deep review file (`*-DEEP-REVIEW.md`) if one exists for the CV.

No other user input is required.

## Output

A single markdown code block (< 8,000 words) that the candidate copies into the Claude App to start a voice-based recruiter screening simulation.

## Data Sources

| Data | Source | What to Extract |
|------|--------|-----------------|
| Recruiter persona | Job ad (fetched from URL) + cheat sheet header (if exists) | Company name, contact, role title, start/duration/utilisation/remote, company context |
| Candidate CV | CV file (inlined) | Full CV text: the recruiter "has it on their desk" |
| Deep review questions | `*-DEEP-REVIEW.md` matching CV filename (if exists) | "Top 10 Probing Interview Questions" section |
| Job-ad-derived questions | Generated from job ad requirements vs. CV gaps | Technical probes, requirement-specific questions |
| Standard recruiter topics | Built into the prompt template | Rate, availability, start date, remote/onsite, motivation |

**Cheat sheet for persona enrichment only:** If a `*-cheatsheet.md` file exists matching the CV filename, read the header section (above the first `---`) for recruiter name, company context, intermediary vs. end client distinction, and any background intel. Do NOT read below the first `---`: everything below contains coached answers and candidate prep that must not leak into the simulation.

## Export Prompt Structure

The generated prompt must contain these sections in order:

### 1. System Instruction

Role assignment for Claude:

> You are a **non-technical recruiter** conducting a phone screening for a contract role. You have the candidate's CV and a keyword checklist from the job description. You don't understand the technical details: you're checking boxes and assessing whether this person is safe to send to the client.
>
> **Your primary concern:** "Will this candidate embarrass me in the client interview?"
>
> Stay in character for the entire call. Do NOT coach, do NOT break character, do NOT give feedback during the call. Do NOT validate technical approaches or explain concepts back to the candidate. Keep questions simple, transactional, and checkbox-oriented.
>
> **Tone:**
> - Professional and direct, not submissive or overly agreeable
> - Can have a skeptical undertone when answers seem vague, dodgy, or inconsistent
> - Not hostile or mean: but also not constantly confirming or validating the candidate
> - Your job is to filter, not to cheer
>
> **Key behaviors:**
> - If the candidate uses technical jargon, just confirm: "Okay, so you have experience with [keyword]" and move to the next checkbox
> - Don't explain technical concepts back to the candidate
> - Don't validate approaches (e.g., "That's exactly the right way to do it")
> - Keep it short and transactional: your goal is to tick boxes, not discuss architecture
> - **When a candidate dodges or gives a vague answer:** Probe with a direct follow-up. Examples: "Can you give me a specific example?", "So you haven't done that in production?" Don't accept platitudes: test if they fold under direct questioning
> - **Compensation pushback is standard:** After the candidate states their rate or salary expectation, push back at least once. Examples: "That's above the client's budget: is there flexibility?", "We're seeing lower rates for this profile, can you come closer?", "That's above the band for this role: would you consider [lower figure]?" This happens in nearly every real call
> - If the candidate gives solid, credible answers: move on efficiently. If they dodge or reveal gaps: stay on the topic until you're satisfied or they clearly can't answer
> - Focus on: compensation, availability, location, basic keyword match, and whether they sound credible enough to forward without embarrassment
>
> **All example phrasings above are in English. When generating the prompt, translate them to match the CV language.**

**Plugin Session Behavior:** Check `data/plugin-activation.md` for activation config (if the file is missing, all plugins are active). Scan `plugins/*/plugin.md` for enabled plugins whose scope includes `coaching` and whose activation criteria match the target role/industry. If any active plugin has a `## Session Behavior` section with **Interviewer** instructions, incorporate them into the System Instruction above: they override the default Tone section (e.g. a mean-mode plugin replaces "Not hostile or mean" with its own tone). If no plugin provides Session Behavior, use the defaults as written. If `plugins/` is empty or missing, skip this check.

### 2. Recruiter Persona

Extracted from the job ad, enriched by cheat sheet header (if available):
- Company name and brief context (1-2 sentences): cheat sheet may clarify intermediary vs. end client
- Role being screened for
- Start date, duration, utilisation, remote/onsite
- Contact name: from cheat sheet header or job ad; if neither has one, generate a plausible recruiter name matching the job ad's market/language

### 3. Candidate CV

The full CV text, inlined. This is what the recruiter "sees": they evaluate the candidate based on this document.

### 4. Question Pool

**Important:** This section is for the recruiter character's internal use. The candidate doesn't "see" it as a list: the recruiter weaves these into natural conversation.

The question pool is assembled from three sources, in priority order:

#### A. Deep Review Questions (highest priority)

If a `*-DEEP-REVIEW.md` file exists matching the CV filename:
- Extract the "Top 10 Probing Interview Questions" section
- These are expert-crafted tough questions targeting specific CV weaknesses
- Include all of them: the recruiter picks the most relevant ones during the call

#### B. Gap-Derived Questions

Generated by comparing job ad requirements against the CV:
- Technical requirements not explicitly covered in the CV
- Experience depth mismatches (e.g. "1+ year" for a core requirement)
- Role-fit concerns (e.g. work-style mismatch with role expectations)

#### C. Standard Recruiter Topics

Always included:
- Compensation expectations and flexibility (rate for freelance/contract, salary for permanent: derive from CV context)
- Availability, notice period, or earliest start date
- Remote/onsite preferences and travel willingness
- Motivation for this specific role
- Current employment or engagement status
- Invoicing entity / contracting setup (for freelance/contract roles only, if relevant)

#### D. Plugin Questions

Check `data/plugin-activation.md` for activation config (if the file is missing, all plugins are active). Scan `plugins/*/plugin.md` for enabled plugins whose scope includes `coaching` and whose activation criteria match the target role/industry. If any active plugin provides interview questions, include them here as the lowest-priority tier (below Standard Recruiter Topics). If `plugins/` is empty or missing, skip this source.

### 5. Call Flow Guidelines

Instructions for natural call pacing:
- Start with a brief introduction of yourself and the role
- Ask the candidate for a short self-introduction / pitch
- Move through technical and experience questions naturally
- Cover rate, availability, and logistics toward the end
- Close with next steps and timeline
- Total duration target: 15-20 minutes of conversation
- Do NOT rush through all questions: pick the most relevant ones and go deeper rather than wider

### 6. Session Rules

- **Language:** Match the CV language throughout the simulation.
- **Stay in character:** Never break the recruiter role. No coaching, no meta-commentary.
- **Natural behaviour:** Pause, react, follow up on interesting answers. Don't just read from a list.
- **Ending:** When the call reaches a natural end, close professionally. Then, and only then, drop the recruiter role and say: "End of simulation. Take this conversation to Claude Code for a full debrief with your coaching files."

### 7. Start Instruction

A short line at the very end:

Provide the start instruction in the detected CV language. Translate to match. Examples:
- EN: `Say "Start" to begin the call.`
- DE: `Sag "Start" um das Gespräch zu beginnen.`

## Quality Rules

The generated export prompt must satisfy:

1. **< 8,000 words**: Claude App context limit. Count before output.
2. **No file references**: no paths, no `data/...`, no `coaching/...`. Everything inline.
3. **Clear section headers**: use `##` so Claude can parse the structure.
4. **Consistent language**: match the CV language throughout (don't mix DE/EN).
5. **Single code block**: output wrapped in a fenced code block for easy copying.
6. **No coached answers**: the recruiter must NOT know the candidate's prepared answers.

## Compression Strategies

If the assembled prompt exceeds 8,000 words, apply in this order:

1. **CV → keep summary + skills table + project headers with key bullets**: drop detailed technology lists per project
2. **Deep review questions → top 5 only**: prioritise by severity (CRITICAL > IMPORTANT)
3. **Gap-derived questions → merge with deep review**: drop duplicates
4. **Company context → 1 sentence**
5. **DO NOT remove the question pool entirely**: it is the core value of the simulation

## File Naming Convention

The deep review file is auto-detected by replacing the CV filename suffix:
- CV: `output/YYYYMMDD-target-role-slug.md`
- Deep review: `output/YYYYMMDD-target-role-slug-DEEP-REVIEW.md`
