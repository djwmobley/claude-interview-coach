---
name: extract-identity
description: Guided coaching conversation to discover your professional identity, strengths, values, and narrative patterns
argument-hint: (no arguments, interactive session)
user-invocable: true
allowed-tools: Read(data/**), Glob(data/**), Write(data/professional-identity.md), Edit(data/professional-identity.md)
---

# Extract Identity: Professional Self-Discovery Conversation

A guided coaching conversation that discovers who you are professionally: your strengths, growth edges, how you frame your work, what you value, and where you're heading. Produces `data/professional-identity.md`, which informs all CV generation and interview coaching.

This is NOT a questionnaire or data extraction. It is a reflective conversation where open-ended questions, follow-ups, and honest reflection matter more than efficient data collection.

## Instructions

### Step 1: Load Context

Read the user's data files to ground the conversation in their real experience. Read in parallel:

- `data/profile.md`: name, title, company, career span
- `data/project-index.md`: project overview (to reference specific engagements)
- `data/skills.md`: skill inventory
- `data/companies.md`: entrepreneurial background (if exists)

Also check if `data/professional-identity.md` already exists:
- If it exists and has real content (not just TODOs): "You already have a professional identity file. Would you like to **go deeper** on what's there, **go wider** into new territory, or **start fresh**?"
  - **Go deeper:** Read the file carefully. For each theme already covered, ask questions that push past the surface: challenge assumptions, test whether stated values match actual behaviour, probe the edges of growth areas. Don't re-ask the same lead questions; instead start from what's written and ask "Is this still true?", "What's changed since this was written?", "You wrote X: can you give me a concrete example?"
  - **Go wider:** Read the file. Skip themes that are already well-covered (3+ bullet points with specific, grounded content). Focus on themes that are thin, missing, or have TODO markers. Also look for gaps between what the data files show (projects, skills) and what the identity file captures: if the data suggests significant leadership experience (founding companies, leading teams, managing contractors) but "Leadership Style" is thin, that's a gap to explore.
  - **Start fresh:** Proceed with the full conversation, write a new file at the end.
- If it doesn't exist or is empty: proceed normally (first-time conversation).

If no data files exist at all (user hasn't run `/import-cv` yet), proceed anyway but note: "I don't have your project history to reference, so the questions will be more abstract. For a grounded conversation, run `/import-cv` first."

### Step 2: Set the Frame

Introduce the session:

> This is a reflective conversation about who you are professionally: your strengths, your growth edges, how you tend to talk about your work, and what matters to you.
>
> There are no wrong answers. Some questions might be hard to answer immediately: that's fine. If something doesn't resonate, say so and we'll move on.
>
> I'll ask about 6-8 themes. After each one, I'll reflect back what I heard so you can correct or refine it. At the end, I'll compile everything into your professional identity file.
>
> Ready to begin?

Wait for the user to confirm before starting.

### Step 3: Conversational Themes

Work through the themes below in natural order. Each theme typically takes 2-3 exchanges (lead question → follow-up → reflection). Adapt based on what emerges: if a theme opens an interesting thread, follow it. If a theme doesn't resonate, move on.

**After each theme:** Pause and reflect back a 2-3 sentence summary of what you heard. Ask the user if the reflection is accurate. This validates the extraction and often triggers deeper insight.

---

#### Theme 1: Professional Identity Core

*Discover:* How the user sees themselves professionally, beyond job titles.

**Lead question:** "When you think about what you do (not your job title, but what you actually *do*), how would you describe it to someone who knows nothing about tech?"

**Follow-up patterns:**
- If they give a job title: "That's the label. But what does it actually *feel* like to do? What's the core of the work?"
- If they describe tasks: "Of all those things, which one feels most like *you*?"
- If they mention ownership: "You mentioned [ownership]. How does that compare to how most people in similar roles work?"
- **Ground in their data:** "I see you've been with [client] for [N] years. What keeps you there?" or "You founded [company]. What drove that?"

**Listen for:** Do they describe themselves through what they build, own, protect, or create? Do they minimise or amplify?

---

#### Theme 2: Strengths

*Discover:* What the user is genuinely excellent at: including what they might not recognise.

**Lead question:** "What are you genuinely better at than most people in your field? Not just skilled at: what would the person who relies on your work most say you do that others can't?"

**Follow-up patterns:**
- If they deflect: "Let me ask differently. Think of a time when someone else handled the same type of work and it didn't go as well. What did you do differently?"
- If they give only one: "That's one. What's another: something maybe less obvious?"
- If they mention reliability: "Lots of people claim reliability. What makes your version different?"
- **Ground in their data:** Adapt based on their project history: e.g. "I see your longest engagement is [project] for [N] years. What does it take to sustain something that long?" or "You've held multiple concurrent projects: how do you prioritise across them?" or "Your experience spans several industries: what drew you between them?"

**Listen for:** Strengths stated confidently vs. strengths they hedge on. Strengths backed by their track record vs. aspirational ones.

---

#### Theme 3: Growth Edges

*Discover:* Where the user knows they need to grow: told honestly, not as self-flagellation.

**Lead question:** "Every strength has a shadow side. What's something you know you need to work on: or something that's cost you in the past?"

**Follow-up patterns:**
- If they give a cliche ("I'm a perfectionist"): "How does that actually show up? Give me a specific example."
- If they mention delegation: "What stops you from delegating? Trust, control, or something else?"
- If they mention visibility: "When you have the choice to be visible or stay behind the scenes, which do you choose? Why?"
- If they struggle: "What would your harshest critic say? Or what feedback have you received that stung because it was partly true?"

**Listen for:** Are edges framed as permanent flaws or active development areas? Is there a connection between their strengths and their edges (e.g., deep ownership → difficulty delegating)?

**Reflection:** List the edges and explicitly connect each to a related strength. Ask if the connections feel right.

---

#### Theme 4: Narrative Patterns

*Discover:* How the user defaults to framing their experience, and where that default undersells them.

**Lead question:** "When you describe your work to a potential client or in an interview, what do you tend to lead with? And what do you tend to leave out or downplay?"

**Follow-up patterns:**
- If unsure: "Let's try it. Pitch me your work in 30 seconds, right now." Then analyse: "You led with [X] and didn't mention [Y]. Is [Y] less important, or did you just not think to say it?"
- If they mention downplaying something: "Why do you leave that out? What are you worried it signals?"
- **Ground in their data:** "I notice you have [N] years on [their longest project] / founded [N] companies / hold [N] certifications. Do you lead with that, or does it come out late?"

**Listen for:** The gap between what their data shows (impressive) and how they describe it (modest). Recurring verbal patterns ("just", "only", "basically").

**Reflection:** Present a 4-6 row table of `Default framing → Reframe` and ask if each row feels honest (not inflated).

---

#### Theme 5: Work Style & Values

*Discover:* How the user works best and what they won't compromise on.

**Lead question:** "Describe your ideal work setup: not the job, but *how* you work. Remote/office, communication style, team size, autonomy, schedule."

**Follow-up patterns:**
- "What's a non-negotiable? Something you'd turn down an otherwise perfect role over?"
- "Do you optimise for money, freedom, impact, learning, or something else? If you had to rank those."
- If they mention family: "How does family factor into your professional decisions?"

**Listen for:** Values stated explicitly vs. revealed through choices. Non-negotiables vs. preferences.

**Reflection:** Summarise work style as 4-5 bullet points and list core values as a ranked hierarchy.

---

#### Theme 6: Career Direction

*Discover:* Where the user is heading: not where they've been.

**Lead question:** "Where are you headed professionally? Not the 5-year plan, but what feels like the right next step?"

**Follow-up patterns:**
- "Is that a pull (something attracts you) or a push (something you're moving away from)?"
- "What would success look like in 2 years?"
- If uncertain: "What are you NOT interested in? Sometimes knowing what you don't want clarifies what you do."

**Listen for:** Whether direction is clear or emergent. Whether it aligns with stated values.

---

#### Theme 7: Leadership Style (conditional)

*Only if the user has mentioned leading people, teams, or projects during earlier themes.*

**Lead question:** "How would you describe how you lead? Not how you think you should: how you actually do it."

**Follow-up patterns:**
- "What kind of person thrives working with you? What kind struggles?"
- "What's the biggest leadership lesson from experience: not from a book?"

---

#### Theme 8: Meta-Reflection (closing)

**Lead question:** "Looking at everything we've discussed: is there anything that surprised you? Anything you said that you didn't expect to say?"

This final question often produces the most valuable insight. Do not skip or rush it.

---

### Step 4: Compile Draft

After all themes are covered, compile the full `data/professional-identity.md`:

```markdown
# Professional Identity

How I see myself, my work, and my trajectory: distilled from personal coaching.
This is the inner truth that drives positioning, summaries, and interview presence.
Not for direct inclusion in resumes, but the foundation everything else is built on.

---

## Professional Identity

- [2-4 bullet points from Theme 1]

## Strengths

- **[Strength name]:** [Description grounded in evidence]
- ...

## Growth Edges

- **[Edge name]:** [Description with connection to related strength]
- ...

## Narrative Patterns

How I default to framing things → how they should be framed:

| Default framing | Reframe |
|---|---|
| "[what they actually say]" | "[honest, stronger version]" |
| ... | ... |

## Work Style & Values

- **[Aspect]:** [Description]
- ...

## Career Direction

- [3-4 bullet points from Theme 6]

## Leadership Style

- [3-4 bullet points, or omit section if Theme 7 was skipped]

## Core Values (Hierarchy)

1. **[Value]**: [brief description]
2. ...
```

**For returning sessions (go deeper / go wider):** Do not rewrite the entire file. Read the existing file, then:
- **New insights** get added to the relevant section (new bullet point under Strengths, new row in Narrative Patterns table, etc.)
- **Refined insights** replace or expand the existing bullet point they evolved from
- **Contradictions with previous content** get resolved: if the user's view has changed, update the old content, don't keep both
- **Unchanged sections** stay exactly as they are: don't touch what wasn't discussed

### Step 5: Present for Review

Present the compiled document:

> Here's the professional identity I've drafted from our conversation.
>
> [Full document]
>
> Please review:
> - Does each section feel true?
> - Is anything missing or overstated?
> - Do the narrative reframes feel honest: not inflated, not deflating?
> - Is the values hierarchy in the right order?
>
> Tell me what to change and I'll revise.

Iterate until the user is satisfied.

### Step 6: Write File

After confirmation, write or update `data/professional-identity.md`.

Report:

> Saved to `data/professional-identity.md`.
>
> This file is now used by:
> - Resume generation (step 4): for narrative framing and reframes
> - Interview coaching (step 3): to ground coaching in your self-awareness
> - CV quality checks: to catch self-sabotage patterns
>
> You can update this file anytime by running `/extract-identity` again,
> or by editing it directly after coaching sessions.

## Handling Edge Cases

- **Very short answers:** Gently probe deeper: "Can you tell me more?" or "What's an example?" Don't move on too quickly.
- **"I don't know":** Record as useful data. "That's worth noting: it might become clearer through practice."
- **User disagrees with reflection:** Accept immediately. "Thank you for the correction." Never argue about someone's own identity.
- **Contradictory answers:** Note the tension. "I notice you said X earlier and Y just now. Is that a real tension you live with, or did I misunderstand?"
- **User wants to stop mid-session:** Save what's been discussed as a partial file with TODO markers for unfinished themes. They can resume with `/extract-identity` later (the "build on" path).
