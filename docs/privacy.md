# Privacy & Data Handling

This framework stores sensitive career data locally. This document explains what goes where, what's protected by default, and what to watch out for.

## What's gitignored

The `.gitignore` excludes all personal data directories by default:

| Path | Contains | Gitignored |
|---|---|---|
| `data/` | Profile, projects, skills, certifications, education, companies, professional identity | Yes |
| `data/project-background/` | Sensitive background (legal disputes, failures, internal assessments) | Yes (inside `data/`) |
| `coaching/` | Coached answers, anti-pattern tracking, progress scorecards | Yes |
| `output/` | Generated CVs, cheat sheets, review reports | Yes |
| `files/` | PDF input files (CVs you import) | Yes |

Everything in `framework/`, `plugins/`, `docs/`, `tools/`, `.claude/skills/`, `examples/`, and `CLAUDE.md` is safe to commit. These contain methodology and automation only, no personal data.

## What stays local vs. what's shared

```
Safe to push (methodology)          Private (your data)
─────────────────────────           ───────────────────
CLAUDE.md                           data/*
framework/**                        coaching/**
plugins/**                          output/**
.claude/skills/**                   files/**
docs/**
tools/**
examples/**
```

If you fork or clone this repo publicly, the gitignore protections apply automatically. Someone cloning your fork gets the framework, not your data.

## Versioning personal data in a private repo

If you use a private repository and want git history for your career data, you can remove the gitignore lines for `data/` and `coaching/`. The `.gitignore` file has a comment explaining this:

```
# Personal data: ignored by default to prevent accidental exposure.
# If you use a private repo and want to version your data, remove these lines.
/data/
/coaching/
```

Before doing this, verify your repo is private. A public repo with these lines removed exposes everything.

## Sensitive content tiers

Not all personal data is equally sensitive:

1. **Contact and compensation** (`data/profile.md`) - Name, email, phone, rates, salary expectations. Highest sensitivity.
2. **Project background** (`data/project-background/`) - Legal disputes, failed projects, internal assessments. Never used in CVs or client-facing materials, even by the framework itself. This is internal reference only.
3. **Professional data** (`data/projects/`, `data/skills.md`, etc.) - Work history, skills, certifications. The same information that appears on a CV, but in richer detail.
4. **Generated output** (`output/`) - Tailored CVs and reports. Contains personal data but is designed for sharing with specific recipients.

## What Claude sees during a session

When you run a session, Claude Code reads your local files to generate CVs and provide coaching. This data is sent to Anthropic's API for processing. It is subject to [Anthropic's usage policy](https://www.anthropic.com/policies) and data handling practices.

Key points:

- Claude Code reads only the files the framework instructs it to (routed by `CLAUDE.md`)
- Data retention depends on how you authenticate Claude Code:
  - **API key:** Anthropic retains inputs/outputs for up to 30 days for safety, does not train on them
  - **Pro/Max subscription:** Conversations may be stored per Anthropic's consumer terms, and retention policies differ from the API
- Review [Anthropic's privacy policy](https://www.anthropic.com/privacy) for current details on your plan type

## Forking and cloning safely

**Forking a public repo:** The gitignore ensures `data/`, `coaching/`, `output/`, and `files/` are excluded. Your fork will contain only the framework. Populate it with your own data locally.

**Switching from private to public:** Before making a repo public, verify that no personal data was ever committed. Gitignore only prevents future commits. If you previously committed data files, they remain in git history. Use `git log --all --name-only` to audit, and if needed, rewrite history with `git filter-repo` before going public.

**Cloning someone else's repo:** You get the framework only. Run `/import-cv` with your own CV to populate the data layer.

## Checklist before pushing

- [ ] `data/profile.md` is not tracked (`git status` should not list it)
- [ ] No files in `data/`, `coaching/`, `output/`, or `files/` are staged
- [ ] No personal data was accidentally added to framework files or CLAUDE.md
- [ ] If you modified `.gitignore`, you didn't remove the personal data exclusions on a public repo
