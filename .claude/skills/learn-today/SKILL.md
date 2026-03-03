---
name: learn-today
description: Daily learning prompt — surfaces today's module from the active learning plan, links to it, and quizzes on completed material
argument-hint: [quiz [week1|week2|<module-id>]] [done [<module-id>]] [plan]
user-invocable: true
allowed-tools: Read(*), Edit(data/learning-plan.md), Glob(*)
---

# Learn Today

Surfaces today's learning module from the active learning plan. Links directly to
the resource with focused "what to look for" guidance tailored to the candidate's
background. Optionally quizzes on completed material and logs progress.

## Arguments

- No argument: show today's module with guidance
- `quiz` or `test`: quiz on the most recently completed module
- `quiz week1` / `quiz week2`: quiz on all modules from that week
- `quiz <module-id>`: quiz on a specific module (e.g., `quiz A1`)
- `done`: mark today's scheduled module as complete and log it
- `done <module-id>`: mark a specific module as complete (e.g., `done A1`)
- `plan`: display full learning plan with completion status and progress log

---

## Instructions

### Step 1: Load the Learning Plan

Read `data/learning-plan.md`. If the file doesn't exist, tell the user:
> No active learning plan found. Run `/skill-gap` first to generate one.

Read and parse:
- Active roles (what interviews this is preparing for)
- Track A and Track B module tables (ID, Module, Platform, URL, Duration, Status, Date Completed, Test Score)
- Day-by-day schedule tables (which module is assigned to each day)
- Progress log (what has been completed and when)

Also read `data/profile.md` and `data/professional-identity.md` to personalise the guidance to the candidate's background.

---

### Step 2: Route by Argument

---

#### Mode: Default (no argument) — Show Today's Module

1. Scan the Day-by-Day Schedule in order (Week 1 Day 1, Day 2, ... Week 2 Day 8, etc.)
2. Find the first non-QUIZ day where the referenced module ID has Status = `pending`
   - If today is a QUIZ day in the schedule (all prior week's modules are done), prompt quiz mode instead
3. If all modules are complete, congratulate and suggest next steps (PgMP application, interview practice)

**Display today's module:**

```
## Today's Learning Module — [Day X of plan]

**[Module Name]**
Platform: [Platform] ([Free / LinkedIn Learning subscription / Paid])
Duration: [duration]
Link: [URL]

### What to Watch For

[Generate 4-6 specific bullet points tailored to this candidate's background. For example:
- For treasury modules: connect concepts to existing ERP integration and payment experience
- For agile/SAFe modules: connect to the candidate's PMO build and program delivery background
- For financial services modules: connect to compliance-governed delivery experience
Focus on concepts that will come up in the JPMC interviews for the active roles.]

### Why This Matters for Your Applications

[1-3 sentences: exactly how this topic connects to the JPMC interviews. Be specific —
e.g., "The treasury centralization concept from this module is directly what the
Executive Director role is consulting on. If asked how you'd approach a treasury
transformation engagement, this gives you the vocabulary to speak the client's language."]

---
When you finish: type `/learn-today done` to log completion and update your tracker.
To quiz yourself on this module later: type `/learn-today quiz [module-id]`
```

---

#### Mode: Quiz / Test

Determine which module(s) to quiz:
- `quiz` alone: quiz on the most recently completed module (highest date in progress log)
- `quiz week1`: quiz on all Week 1 modules that have Status = `done`
- `quiz week2`: quiz on all Week 2 modules that have Status = `done`
- `quiz <module-id>`: quiz on that specific module

**Generate 5 targeted questions per module being quizzed.** Questions should be:
- Knowledge questions about the module's core concepts (2 questions)
- Application questions: "How would you explain [concept] to a CFO / program sponsor?" (1 question)
- Bridge questions: "How does [module concept] connect to your experience at [relevant company]?" (1 question)
- Interview simulation question: one question the JPMC interviewer might ask that this module prepares you for (1 question)

After the candidate answers all questions:
- Give feedback on each answer (correct / partially correct / incorrect with explanation)
- Calculate a score out of 5
- Ask if they want to record the score in their learning plan

If they confirm, update the module's Test Score in `data/learning-plan.md` using the Edit tool.

---

#### Mode: Done — Mark Module Complete

**`done` (no module ID):** Mark the next pending module in the schedule as complete.
**`done <module-id>`:** Mark that specific module as complete.

1. Identify the module to mark
2. Update the Status column from `pending` to `done` and set Date Completed to today's date
3. Append a row to the Progress Log table at the bottom of `data/learning-plan.md`
4. Display:

```
Logged: [Module Name] — complete as of [date]

Next up: [next pending module name and link]
Or quiz yourself: `/learn-today quiz [completed-module-id]`
```

Use the Edit tool to update both the module table row and the progress log in `data/learning-plan.md`.
Apply updates precisely — do not rewrite sections that haven't changed.

---

#### Mode: Plan — Show Full Status

Display a summary of the complete learning plan:

```
## Learning Plan Status — [date]

Roles: [active roles from the plan]
Progress: [X of Y modules complete]

### Track A: Treasury & Payments
[table showing all modules with status, completion date, and test score]

### Track B: Program Delivery & Enterprise Agile
[table showing all modules with status, completion date, and test score]

### PgMP Track
[current status: not started / application in progress / submitted / passed]

### Progress Log (last 5 entries)
[last 5 rows from the progress log]
```

---

### Step 3: Guidance Generation — Quality Rules

When generating "What to Watch For" content:

**DO:**
- Reference the candidate's specific companies and projects by name (Norwex/Chase Paymentech, Monat/Fiserv, Immunotec/SAP)
- Connect each concept to one of the two active JPMC roles explicitly
- Highlight vocabulary the candidate should be able to use naturally in an interview (not just recite definitions)
- Flag any concepts that contradict or require reframing from the candidate's existing mental model

**DO NOT:**
- Give generic course summaries that could apply to any learner
- Repeat information the candidate already clearly knows at expert level
- Over-explain basic project management or technology concepts that are at Expert level in the profile
