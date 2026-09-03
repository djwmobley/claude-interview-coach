# AI Interview Coach

Turn [Claude Code](https://docs.anthropic.com/en/docs/claude-code) into a complete interview preparation toolkit. Practice job interviews with AI coaching, mock interview simulations, recruiter screening practice, and progress tracking. Plus targeted CV generation. No code, just markdown.

For freelancers and job seekers who use Claude Code.

## What it does

- **Practice job interviews** with real-time AI coaching that catches your mistakes after every answer (or full uninterrupted interview simulations with debrief)
- **Recruiter screening practice** via voice simulation through the Claude mobile app, then debrief the transcript
- **Track improvement** with anti-pattern counts, structured scorecards, and session logs
- **Generate tailored CVs** from a single experience database: one job ad in, one role-specific CV out
- **Scan job boards** for matching roles with fit scoring

## What coaching looks like

All examples below are from a tough-mode interview with the fictional example profile (Alex Chen). The questions, pressure points, and coached answers are generated automatically from the job ad and the candidate's project data. Nothing is scripted.

**The coaching loop:** you answer, the coach catches anti-patterns and provides the strongest version:

> **Recruiter:** "The role is heavily Go: it's our primary language for platform services. I see three years on your CV. The engineers on this team have been writing Go for seven, eight years. How would you handle that gap in experience?"
>
> **You:** "Probably not as good as them *laughs*. But I'm a quick learner."
>
> **Coach:** That answer just killed your candidacy. Let me be specific about why:
>
> "Probably not as good as them": she didn't say you're worse than the team. You said that. She asked how you'd handle the difference. You confirmed yourself as the weakest engineer on the team before you've even interviewed. That goes straight into her notes.
>
> "I'm a quick learner": every single candidate says this. It means nothing. It's the recruiter equivalent of white noise.
>
> Anti-patterns triggered:
> - **Confirming the recruiter's concern**: she floated the gap. You confirmed it and made it worse.
> - **Volunteering negatives**: she said the team has 7-8 years. She didn't say "so you'd be the weakest." You volunteered that.
> - **Generic self-description**: "quick learner" is not a differentiator.
> - **Missing quantitative checkboxes**: you have 3 years of Go. You didn't even state the number or what you built with it.
>
> What she actually needed to hear: what you've built with Go, and why 3 years of production Go from someone who also does infrastructure is different from 3 years of Go from a pure backend dev.
>
> **Strongest version:** "Three years of production Go: I built the microservice layer at NordPay for their payment platform, and I wrote Go tooling at ShopStream for the internal developer platform. My angle isn't competing on pure language years: it's that I write Go AND design the infrastructure it runs on. Most Go engineers don't think about the platform layer. I do both. Is the team looking for a pure Go specialist, or someone who bridges Go development and infrastructure?"

**Session debrief:** after each session, you get structured feedback and a concrete focus for next time:

> **Dominant patterns:** Volunteering negatives (5 of 8 answers) and not answering the actual question (4 of 8).
> No gap reframing applied: despite having frameworks for it, zero questions used the acknowledge-pivot-question back pattern.
>
> **Focus for next session:**
> 1. Write and memorise 15-second recruiter pitch
> 2. Practise gap reframing on 3 common gaps
> 3. Practise direct answer structure: answer first, brief context, stop
> 4. Work on emotional regulation: when a question feels unfair, pause, don't react

**Progress tracking:** anti-pattern counts across sessions so you can see improvement over time:

> | Anti-Pattern | Total | Trend |
> |---|---|---|
> | Volunteered a negative unprompted | 5 |: (baseline) |
> | Not answering the actual question | 4 |: (baseline) |
> | Hedging on rate/availability/logistics | 2 |: (baseline) |
> | Confirming recruiter's concern | 2 |: (baseline) |

## Quick start

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and configured (Max subscription recommended: coaching sessions and deep reviews are token-intensive)
- Git
- Python 3.8+ (optional, only needed for PDF generation)

### 1. Clone and try the demo

```bash
git clone https://github.com/raphaotten/claude-interview-coach.git
cd claude-interview-coach
```

The repo includes a fictional profile so you can try all features without importing your own data:

```bash
cp -r examples/data/* data/
cp -r examples/output/* output/
```

Then open Claude Code in the repo and try:
- `/review-cv output/sample-cv-cloud-engineer.md` to review the sample CV
- `/review-cv-deep output/sample-cv-cloud-engineer.md` for a six-perspective deep review (recruiter, hiring manager, competitor, skeptic, copy editor, source data auditor)
- `I want to practice an interview for a Senior Cloud Engineer role` to try mock interview practice

### 2. Import your own data

```
/import-cv path/to/your-cv.pdf
```

This creates your profile, skills, certifications, education, and projects as structured `data/` files. Your personal data stays private (`data/profile.md` is gitignored). You can also paste text directly with `/import-cv paste`, and run it multiple times to merge data from different documents.

### 3. Use it

- **Enrich your data** over time: coaching sessions surface missing details automatically, or browse your `data/projects/` files and fill in key achievements manually
- **Discover your professional identity** with `/extract-identity` (improves tone and narrative quality)
- **Generate a CV:** paste a job ad and ask for a targeted CV
- **Practice interviews:** ask for mock interview practice or recruiter screening practice for a role, choose normal or tough mode
- **Voice simulation:** run `/voice-export` to get an interview simulation prompt for the Claude mobile app, practice by speaking, then `/debrief` the transcript

## Available commands

| Command | What it does |
|---|---|
| `/import-cv <path>` | Import a CV into structured data files (additive merge) |
| `/extract-identity` | Guided conversation to discover your professional identity |
| `/review-cv` | Fast quality-gate review of a generated CV |
| `/review-cv-deep` | Six-perspective deep-dive CV review |
| `/voice-export <cv> <url>` | Generate recruiter screening simulation prompt for voice mode |
| `/debrief <cv>` | Analyse a voice simulation transcript |
| `/scan-jobs <portal> [query]` | Scan a job portal for matching projects (upwork.com, etc.) |

## Repository structure

```
CLAUDE.md              ← Orchestration: tells Claude where everything is
framework/             ← Reusable methodology (workflows, coaching, strategies)
data/                  ← Your professional data (templates included, private once filled)
coaching/              ← Coaching outputs and progress tracking (private once used)
examples/              ← Fictional example data to try features before importing
.claude/skills/        ← Claude Code skill definitions
tools/                 ← PDF conversion utilities
output/                ← Generated CVs and reports
docs/                  ← Framework documentation
```

## How it works

The framework has three layers:

1. **Data layer** (`data/`): your professional experience in structured markdown
2. **Methodology layer** (`framework/`): workflows, coaching methodologies, answering strategies
3. **Automation layer** (`CLAUDE.md` + `.claude/skills/`): tells Claude how to use the first two layers

Claude Code reads `CLAUDE.md` at the start of every session. The `.claude/skills/` folder defines the slash commands. Together, they make the framework work without any code. For the full explanation: **[docs/methodology.md](docs/methodology.md)**

## Adapting to your market

Works out of the box for any market and career type. The defaults lean DACH/European, but all coaching frameworks (gap reframing, pin-down defense, direct answer structure) are universally applicable.

- Edit `framework/style-guidelines.md` for your market's CV conventions (US, UK, DACH, and international formats are included)
- Add answering strategies in `framework/answering-strategies/` for pressure points specific to your domain
- `/scan-jobs` works with any job portal

## License

Dual-licensed:
- **Code** (tools/, .claude/skills/, CLAUDE.md): [MIT](LICENSE)
- **Written methodology** (framework/, coaching/ templates): [CC BY 4.0](LICENSE)

Your personal data in `data/` and `coaching/` is yours. The licenses cover only the framework and tooling.

If this helped, consider starring the repo.

## Credits

Originally created by [Raphael Otten](https://www.linkedin.com/in/raphaelotten/)
