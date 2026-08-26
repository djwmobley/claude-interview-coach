---
name: write-cover-letter
description: Write a targeted cover letter for a specific role, conversational, in the candidate's voice, no resume regurgitation, generates DOCX via cover_letter_to_docx.py
argument-hint: <job-ad-url-or-file-or-paste>
user-invocable: true
allowed-tools: Read(*), Write(*), Edit(*), Glob(*), WebFetch, mcp__job-search__render_doc
---

# Write Cover Letter

Produce a targeted, voice-matched cover letter for a specific role. Not a
formatted resume summary. Not a list of credentials. A letter a human being
would actually write.

## Arguments

- `$ARGUMENTS` (required): The target role: one of:
  - A URL to a live job posting
  - A file path to a saved job description
  - A pasted job description (if no argument, ask the candidate to paste it)

---

## NON-NEGOTIABLE RULES

These override all judgment calls.

### Writing Rules (zero exceptions)

- **No em-dashes anywhere.** Use commas, semicolons, colons, or periods instead.
- **No scare quotes around individual words.** Putting a word in quotes to signal
  distance or emphasis ("building", "overseeing", "transformation") is an AI
  writing tell. If the word needs qualification, rewrite the sentence. If it
  doesn't, use it plainly.
- **No AI buzzwords:** spearheaded, leveraged, championed, harnessed, utilized,
  orchestrated, revolutionized, transformative, cutting-edge, game-changing,
  robust, seamless, synergies, unlock. Stop and replace on sight.
- **No resume regurgitation.** Do not restate bullet points from the resume.
  The letter should say things the resume cannot, perspective, reasoning,
  genuine interest, how the candidate thinks. If a sentence could appear in a
  resume, cut it.
- **No weakness admissions of any kind.** This includes:
  - "Currently expanding my knowledge of..."
  - "Looking to broaden my exposure to..."
  - "Haven't worked in [industry] but..."
  - Any framing that implies the candidate is sheltered, limited, or looking
    to fill a gap in their background
  - Any sentence that begins by acknowledging a narrow history and pivoting
    to "but I'm ready to learn"
  - Framing years in one industry as a liability ("I've been focused on X,
    but I'm looking for more variety")
  - **The candidate's breadth of domain is not a topic for discussion in a
    cover letter. Never raise it.**
- **No hollow openers.** Do not start with:
  - "I am writing to express my interest in..."
  - "I was excited to see this opportunity..."
  - "With over X years of experience..."
  - Any variation of the above.
- **Pleasantry-first for known contacts (HARD RULE: repeatedly violated, do not skip).**
  When the letter goes to someone the candidate is already in contact with (a
  recruiter who sent the spec, a referral conversation, any established thread),
  the letter MUST OPEN with a genuine pleasantry: thank them for the spec, the
  contact, or the conversation BEFORE the hook. This is NOT a hollow opener,
  the hollow-opener ban covers formulaic template phrases, never genuine thanks
  to a real person. These two rules are complementary, not in tension. A letter
  to a known contact that opens straight into the pitch is a rule violation.
- **No formal sign-off phrases.** "Sincerely," "Best regards," "I look forward
  to hearing from you", all cut. The letter ends with the candidate's name.
- **Informal slant, always.** This candidate is direct, candid, and
  conversational. Not formal. The letter should sound like something a sharp
  person wrote, not like a template.

### Structure Rules

- **4 paragraphs maximum.** Tight. If you can say it in 3, use 3.
- **Do not open with "I".** Start with the role, the company, the problem, or
  an observation, something that shows the candidate is thinking, not just
  applying.
- **Each paragraph must do one job:**
  1. Why this role / what specifically caught attention (not generic enthusiasm)
  2. One concrete proof point from career history: told as a story, not a list
  3. A direct, honest take on the most significant requirement or gap: owned
     confidently, never hedged
  4. Close: what makes this role genuinely the right next move: said with
     conviction, no apology, no future-aspiration language

### Output Rules

- **Source file:** plain `.txt`, no markdown `---` dividers
- **Converter:** the `render_doc` MCP tool with `kind:'cover_letter'`. It runs
  `tools/cover_letter_to_docx.py` itself (never `md_to_docx.py`) and refuses to
  render until every preflight check passes: em-dash, scare quotes, buzzwords,
  the problem-comparison reframe, and output naming. Never run the converter or
  grep by hand.
- **Output paths:**
  - Source: `output/markdown/YYYYMMDD-[slug]-cover.txt`
  - DOCX: `output/coverletters/<outName>.docx` where `outName` is a human name
    such as `Jordan Reyes - Cover Letter - [Company]`. Datestamped slugs are
    refused for cover letters. No `.docx` in `outName`.
- **Never open the DOCX after generating it.** The candidate opens it. If
  `render_doc` returns `LOCKED`, ask whether to close Word or edit the document
  directly; never regenerate over a hand-edited DOCX.

### LinkedIn InMessage Format

When the user asks for a LinkedIn note, InMessage, or message to a recruiter:

**Platform limits (for reference):**
- InMail body: 1,900 characters max (Premium subscription: Damian has Premium)
- Subject line: 200 characters max (separate field)
- **Default: keep it short, 3-4 sentences.** If the user says "expand" or "add more",
  go to 5-8 sentences, enough for one concrete story and a role-specific observation.
  Never fill the 1,900-character limit just because it exists.

**Format rules:**
- **Always start with "Hi [first name],"**: use their first name, not full name.
  This is a message, not a letter. It should feel like something a person typed.
- **Write in first person throughout.** Use "I", "me", "my": this is a note from
  Damian to a specific person. Never describe him in the third person or use
  passive/press-release constructions like "Plano based, own property there."
  That is a press release about him, not a message from him. Write "I'm based in
  Plano and own property there" instead.
- **No keyword lists.** If a sentence has a colon followed by comma-separated
  skills or attributes, it is a keyword list disguised as a sentence. Rewrite as
  connected prose or drop it.
- **Do not call out role details just to signal you read the posting.** Only
  reference something specific about the role if it genuinely advances the case
  for hiring him, not just to show he paid attention.
- **3-4 sentences by default; 5-8 if asked to expand.** One to reference the role.
  One or two with the strongest credential, told as a concrete fact or brief story.
  One soft CTA. If expanding, one paragraph of concrete proof is enough.
- **No DOCX output.** Present the message as plain text, ready to copy.
- **All writing rules still apply:** no em-dashes, no AI buzzwords, no scare quotes.
- **End with a low-friction CTA.** "Happy to connect." or "Happy to chat if it
  looks like a fit." Nothing that requires effort to respond to.
- **Always report the character count** alongside the message.

**Example structure (not a template, adapt to the situation):**
> Hi [first name], I [saw / was interested in] the [role].
> I'm [location detail if relevant].
> I've spent [X years] [doing the relevant thing], most recently as [title].
> [One concrete proof point told briefly as a story, not a list.]
> Happy to connect.

---

## Instructions

### Step 1: Load Candidate Data

Read in parallel:
- `data/profile.md`: contact info, compensation, availability
- `data/professional-identity.md`: voice, strengths, narrative patterns,
  growth edges, values
- `data/project-index.md`: role history for concrete proof points

Also read `memory/voice.md` if it exists.

**Extract before writing:**
- The candidate's natural communication style (direct, candid, not formal)
- Their strongest differentiators for this specific role
- The one or two things in their history that are most relevant: not a list
- Any growth edges or framing traps to avoid (from professional-identity.md)

---

### Step 2: Load the Job Posting

If a URL was provided, fetch it. If a file path, read it. If neither, ask.

Fetch prompt:
```
Extract the complete job posting text. Include every section: title, description,
responsibilities, required qualifications, preferred qualifications, and any
stated nice-to-haves. Do not summarise, reproduce the full text.
```

---

### Step 3: Identify the Letter's Core Argument

Before writing, decide:

1. **The hook**: what specific thing in this posting justifies a letter?
   Not "it's a good match." Something particular. A model, a framing, a
   requirement that connects directly to a specific thing in the candidate's
   history.

2. **The proof point**: one story from the candidate's career that speaks to
   the role's core need. Told briefly as narrative, not as a credential list.

3. **The honest take**: the most significant requirement or potential concern
   in the posting. How does the candidate actually stand on it? Own it directly.
   Do not hedge, do not pre-apologize, do not acknowledge and pivot.

4. **The close**: why is this the right role at the right time? Must be
   specific to this role, not generic ("I'm looking for my next challenge").
   Must not imply any limitation in the candidate's current or prior experience.

Write these four points down before drafting a single sentence of the letter.

---

### Step 4: Draft the Letter

Follow the structure rules exactly:

**Paragraph 1: The hook**
If the recipient is a known contact, open with the genuine pleasantry FIRST
(thanks for the spec / contact / conversation), then flow into the hook.
Why this specific role. What caught attention. Must show the candidate has
actually read and thought about the posting, not just applied. Conversational.
Can reference something unusual or specific about how the role is framed.

**Paragraph 2: The proof point**
One story, briefly told. Not a bullet list. Not "at Company X, I did Y and
achieved Z." More like: here's what was happening, here's what I did, here's
why it mattered. 4–6 sentences maximum.

**Paragraph 3: The honest take**
Address the most significant requirement or concern directly. Do not hedge.
Do not pre-apologize. Own the position with confidence. If the candidate
has done the thing, say so plainly. If there's an adjacent experience that
covers it, make the connection explicitly, do not leave the reader to
figure it out.

**Paragraph 4: The close**
Why this is the right move. Not aspirational. Not future-looking in a way
that implies the current situation is lacking. Specific to this role and
this company. Ends with something that makes a hiring manager want to
continue the conversation.

---

### Step 5: Pre-Output Checklist

```
Pre-Output Checklist:
[ ] No em-dashes anywhere
[ ] No AI buzzwords
[ ] No resume regurgitation (no sentence that could appear verbatim in the resume)
[ ] No weakness admissions of any kind
[ ] Does not open with "I"
[ ] No hollow opener ("I am writing to...", "I was excited to see...")
[ ] Known contact? Letter OPENS with a genuine pleasantry/thanks before the hook
[ ] No formal sign-off ("Sincerely," etc.)
[ ] No language implying the candidate is sheltered, limited, or seeking new exposure
[ ] 4 paragraphs or fewer
[ ] Each paragraph does exactly one job
[ ] Sounds like a person, not a template
[ ] Conversational register throughout, informal but not unprofessional
```

Fix any failures before writing the file.

---

### Step 6: Write and Generate

1. Write the `.txt` source to `output/markdown/YYYYMMDD-[slug]-cover.txt`

   **File format (no markdown, no `---` dividers):**
   ```
   [Candidate Name]
   [Contact line]

   [Date]

   [Recipient Name/Team]
   [Company]

   Re: [Role Title]

   [Paragraph 1]

   [Paragraph 2]

   [Paragraph 3]

   [Paragraph 4]

   [Candidate Name]
   ```

2. Preflight: `render_doc({kind:'cover_letter', source:'output/markdown/YYYYMMDD-[slug]-cover.txt', outName:'Jordan Reyes - Cover Letter - [Company]', checkOnly:true})`.
   Fix every `fail` in the source (line numbers are in `checks[]`) and preflight
   again until everything is `pass` or `not-applicable`.

3. Render: `render_doc({kind:'cover_letter', source:'output/markdown/YYYYMMDD-[slug]-cover.txt', outName:'Jordan Reyes - Cover Letter - [Company]'})`.
   Note the `output_path` in the response. Do not open the file.

---

### Step 7: Deliver

Tell the candidate:
- DOCX path (from `render_doc`); it is not opened automatically
- The core argument the letter is built on (hook, proof point, honest take)
- Any significant choice made in the letter that the candidate should know about
