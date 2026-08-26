# Skill: /research-company

## Purpose

Produce a styled HTML interview intelligence brief for a specific company and role.
Uses a parallel agent fleet to research the company, people, tech stack, and culture
simultaneously. The orchestrator synthesizes findings and generates the brief.

Output: `output/research/YYYY-MM-DD-<company-slug>.html`

---

## Invocation

```
/research-company <company-website-or-name> [job-ad-url]
```

Examples:
```
/research-company srsdistribution.com https://jobs.lever.co/srs/...
/research-company "Acme Corp" https://www.linkedin.com/jobs/view/...
/research-company acmecorp.com        # job ad optional if already in session context
```

If referral call notes or insider corrections have been shared in this session,
flag them — they will be incorporated into a Referral Intelligence section that
overrides conflicting web research.

---

## Orchestration Architecture

You are the orchestrator. You run at Sonnet quality — you synthesize, judge, and write.
Sub-agents run in parallel and return structured data dumps. You do not run any web
research yourself. You read local files and generate the final HTML.

```
ORCHESTRATOR (you — Sonnet)
├── Agent A: Company Research        [general-purpose, background]
├── Agent B: Tech Stack Research     [general-purpose, background]
├── Agent C: People Research         [general-purpose, background]
└── Agent D: Culture & Context       [general-purpose, background]
         ↓ (all four return)
ORCHESTRATOR: read candidate files → synthesize → generate HTML
```

**Model guidance:**
- Agents A and B (web scraping, structured extraction): if latency matters, these can
  run via bash with Haiku for cost/speed:
  `claude --model claude-haiku-4-5-20251001 -p "your prompt" --output-format text`
- Agent C (people research, reasoning about relationships): general-purpose preferred
- Agent D (culture analysis, nuance): general-purpose preferred
- Default: launch all four as Agent tool calls with `run_in_background: true`

---

## Step 0 — Parse inputs and load session context

Before spawning agents:
1. Extract company name and website from the invocation argument
2. Note the job ad URL if provided
3. Note any referral call intel shared in this session — capture verbatim
4. Confirm `output/research/` directory exists (create if not)

---

## Step 1 — Spawn all four agents simultaneously

Launch all four as Agent tool calls with `run_in_background: true`.
Do NOT wait for one before launching the next. All four fire at the same time.

---

### Agent A — Company Research

**Subagent type:** general-purpose
**Run in background:** true

**Prompt template:**
```
Research [COMPANY NAME] ([COMPANY URL]) for a job interview.

Return a structured report covering ALL of these — be specific, use real numbers:

COMPANY FUNDAMENTALS:
- Full legal name, HQ location, founded year
- Core business: what they sell, who buys it, how they make money
- Revenue, employee count, number of locations (most recent public figures)
- Public/private/PE-backed/subsidiary status — who owns them
- Any parent company or notable investor

RECENT STRATEGIC EVENTS (last 24 months):
- Acquisitions made (name, size, date, stated rationale)
- Being acquired / merger activity
- Leadership changes at C-suite or VP level
- Major product launches or platform announcements
- Layoffs or restructuring (with scale and timing)
- Funding rounds if private

AI / DIGITAL TRANSFORMATION:
- Any public AI initiatives, platform deployments, or transformation programs
- Named AI tools or vendors mentioned in press releases or job postings
- Conference appearances or summit hosting on AI topics

CURRENT HIRING CONTEXT:
- How many roles are posted in IT/technology right now
- Whether the target role looks like a backfill or a new seat
- Any patterns in simultaneous postings that suggest org restructuring

Use WebFetch and Playwright as needed. Check: company website, LinkedIn company page,
recent press releases, news articles (Google News search), and the company's own
newsroom/blog. Do not guess or extrapolate — if a fact is unconfirmed, say so.
```

---

### Agent B — Tech Stack Research

**Subagent type:** general-purpose
**Run in background:** true

**Prompt template:**
```
Research the technology stack used by [COMPANY NAME] ([COMPANY URL]).
The candidate is interviewing for: [ROLE TITLE — or "a senior IT leadership role" if unknown].

Return a structured tech stack report:

CONFIRMED STACK (sources for each):
- ERP / core business system (name, vendor, version if known)
- CRM platform
- Cloud provider(s)
- Integration / middleware layer
- HR / payroll system
- ITSM / ticketing
- Data / analytics platform
- AI or automation tools named publicly

HOW TO FIND IT:
1. Job postings on the company's careers page — filter for IT/engineering roles.
   Tech requirements in postings are more accurate than press releases.
2. LinkedIn employee profiles with "skills" or "experience" sections mentioning platforms
3. Vendor case studies: search "[company name] case study" on SAP, Salesforce, Oracle,
   Microsoft, Workday, ServiceNow, MuleSoft, Azure, AWS sites
4. Press releases naming specific vendors
5. The job ad at [JOB AD URL] if provided

FLAG any tool or platform that appears in only one source vs confirmed across multiple.
Flag any discrepancy between sources (e.g. two sources name different ERPs).
```

---

### Agent C — People Research

**Subagent type:** general-purpose
**Run in background:** true

**Prompt template:**
```
Research the IT leadership team at [COMPANY NAME] ([COMPANY URL]) for a
[ROLE TITLE] interview.

For each person likely to be in the interview loop, produce a structured profile.

PEOPLE TO FIND:
- CTO / CIO / EVP IT (the likely hiring executive)
- Direct reporting line (VP or SVP IT)
- Peer VPs or Directors in adjacent functions
- Current incumbent in the target role (search LinkedIn for "[title] at [company]")
- CDO or Chief Digital Officer if present

FOR EACH PERSON FOUND:
Name:
Title:
Tenure at this company (years):
Prior companies (last 2-3 roles):
Industry background:
Education (if visible):
Public content (LinkedIn posts, conference talks, press quotes — summarise themes):
Shared background with a candidate from [CANDIDATE LOCATION] with background in
  [enterprise IT, ERP implementations, direct sales industry]:

Use LinkedIn via Playwright, company leadership pages, press releases, and
conference speaker bios. Note if a profile is sparse or unverifiable.
```

---

### Agent D — Culture and Context Research

**Subagent type:** general-purpose
**Run in background:** true

**Prompt template:**
```
Research the culture and operating environment at [COMPANY NAME] ([COMPANY URL]).
Focus on what a VP-level candidate needs to understand before walking in.

COVER ALL OF THESE:

GLASSDOOR / EMPLOYEE SENTIMENT:
- Overall rating (current)
- Review themes from the last 12 months (not older)
- Any sharp rating changes post-acquisition or post-leadership-change
- Common complaints and common praise
- CEO approval rating trend

POST-ACQUISITION DYNAMICS (if applicable):
- Has the company been acquired recently? When?
- What do employee reviews say about culture before vs. after?
- Were there compensation or benefits changes post-acquisition?
- Are there signs of culture clash between legacy and acquirer culture?

EXECUTIVE TONE:
- How does leadership communicate publicly? (LinkedIn posts, press interviews)
- Formal/corporate vs. entrepreneurial/scrappy framing?
- Any public statements about employees, values, or operating philosophy?

INDUSTRY ENVIRONMENT:
- Is the sector they operate in under pressure right now? (housing, retail, etc.)
- Any macro tailwinds or headwinds that are likely to come up in conversation?

Use Glassdoor via Playwright, LinkedIn company posts, news articles, and
any public executive interviews. Be specific about timing — note when reviews
or quotes are from.
```

---

## Step 2 — Read candidate context (while agents run)

While the four agents are running, read local files:

1. `data/profile.md` — comp target, location, current situation
2. `data/project-index.md` — all projects for relevance scanning
3. `data/professional-identity.md` — if it exists, how candidate frames their value
4. `data/skills.md` — technology inventory
5. `output/resumes/` — check for any existing resume for this company
6. The job ad URL if provided (WebFetch it directly)

---

## Step 3 — Synthesize all agent returns

When all four agents have returned, synthesize:

**Proof point mapping:**
For each major requirement in the job ad, find the strongest matching project.
Order: direct credential → transferred credential → acknowledged gap with bridge.
Produce 4–6 proof points. For gaps, write the bridge language explicitly.

**Pressure point generation:**
Based on gaps identified, profile mismatches, and role characteristics, generate
4–8 pressure points. Each needs: the question as it would actually be asked,
a DO block (scripted answer in first person), and a DO NOT block (the trap).

Standard pressure points to check:
- Title mismatch (over/under-qualified)
- Sector gap (different industry)
- Platform gap (they use X, candidate has Y)
- Tenure concerns
- CTO-to-VP or similar level change questions
- Acquisition integration scale questions

**Referral intelligence:**
If the session contains referral call notes, create a dedicated section that:
- Lists each piece of confirmed intel as a bullet
- Explicitly notes any corrections to web research (e.g. "Azure confirmed, not MuleSoft")
- Flags cultural intelligence that should inform positioning but NOT be recited

**Scripted openers:**
Generate 2–3 "Lead With This" scripted openers. Each must:
- Reference a real company event (specific acquisition, named AI tool, specific metric)
- Not be generic — if it could apply to any company, rewrite it
- Be written as the candidate would actually speak it (first person, natural)

---

## Step 4 — Generate the HTML brief

Produce a single self-contained HTML file with all CSS inline or in a `<style>` block.

### Design system

```css
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface2: #1c2128;
  --border: #30363d;
  --text: #c9d1d9;
  --muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --yellow: #d29922;
  --purple: #bc8cff;
  --red: #f85149;
  --orange: #e3b341;
  --tag-bg: #21262d;
}
body {
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px; line-height: 1.6;
  padding: 24px; max-width: 960px; margin: 0 auto;
}
```

### Required sections (in this order)

**1. Header**
- `<h1>` company name
- Subtitle: website · HQ · Role title — req number if known
- Badge row: company type (colour-coded by risk/opportunity), interview date if known
- Meta row: research date, role level, comp target (from profile.md), location, travel %

**2. Alert banners** (conditional)
- Green banner: confirmed positive intel (location, timeline, relationship)
- Orange banner: strategic context requiring navigation
- Red banner: critical risk or confirmed negative

**3. Referral Intelligence** (only if referral intel exists in session)
- Blue-bordered section titled "Referral Call Intelligence — [date] (Confirmed)"
- Each bullet: bold the key fact, plain text the implication
- Corrections to web research marked: "Earlier research had X — confirmed Y. Do not use X."

**4. Situation Brief**
- 4–6 bullets: what the company does, what drove this hire, key platform facts,
  culture/political context, reporting structure

**5. IT Leadership**
- Card grid, one card per person
- Primary hiring executive: `border-color: rgba(88,166,255,.4)`
- Each card: name, title, bio, approach note (in `<div class="person-note">`)

**6. Know This Cold**
- 4–6 cards in a grid
- Primary ERP/platform, integration layer, AI agenda, key recent event,
  culture context, full tech stack tag cloud

**7. Proof Points**
- `<ul class="proof-list">` with left-bordered green items
- Each: label (Company — Achievement), paragraph connecting to this role's requirement

**8. Lead With This**
- 2–3 scripted opener blocks
- Blue left border (`border-left: 3px solid var(--accent)`)
- Label in accent colour, scripted text in italic

**9. Pressure Points — DO / DO NOT**
- Question in red italic
- Green DO block with scripted answer
- Red DO NOT block with the trap

**10. Closing Questions**
- 3 questions as the candidate would actually say them (first person, natural)

**11. Pre-Interview 60-Second Scan**
- 10–14 checklist items
- Critical items: `class="critical"` renders red `☐`
- Normal items: grey `□`

**12. Footer**
- `Generated [date] · claude-interview-coach · [Company] Interview Research Brief · Interview: [date if known]`

### Save path

```
output/research/YYYY-MM-DD-<company-slug>.html
```

Where company-slug is lowercase, hyphenated (e.g. `srs-distribution`, `acme-corp`).

---

## Step 5 — Confirm and offer next steps

```
Research brief saved: output/research/YYYY-MM-DD-<company-slug>.html

Open in a browser to review. Things to verify:
  · People section — confirm names and titles are current
  · Tech stack — correct anything that looks wrong
  · Proof point framing — adjust if any example needs tightening

To update with referral intel: paste your call notes and I'll regenerate
the Referral Intelligence section and update affected pressure points.

Suggested next steps:
  /coaching  — run a recruiter screening using this brief as prep context
  /write-resume [job-ad-url]  — if not already done
```

---

## Quality Rules

- Never invent company details. Unconfirmed = say so or omit.
- Job ad text is ground truth for tech stack — more accurate than press releases.
- Pressure point answers must use the candidate's ACTUAL projects and outcomes.
  No hypothetical answers. If no direct credential exists, write the bridge — not fiction.
- Scripted openers must name real events: actual acquisition, actual AI tool, actual metric.
  Generic framing that could apply to any company must be rewritten.
- Referral intelligence always overrides web research. Once corrected, the wrong fact
  must not appear anywhere in the brief — not even as "previously believed to be X."
- Glassdoor culture intel: include as "read the room" positioning guidance only.
  Do not include it as a fact to recite in the interview.
- Everything is reviewable. This is prep material. The candidate reads and corrects
  before the call.
