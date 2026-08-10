# Agent definitions

Drop these in `~/.claude/agents/`. They work in the CLI today, with or without Stafford.

Six roles: pm-assistant, lead-developer, developer, code-reviewer, qa-tester, writer.

## What is actually enforced

Only `tools` is enforced by Claude Code. An agent physically cannot use a tool absent from
that list, which is why the code reviewer has no write tool and the writer has no shell.

Everything else in these files is instruction, and an instruction can be ignored:

- `paths` on the writer is advisory. Nothing stops it editing code today. Stafford has to
  enforce it.
- `delegation` and `seniority` are read by Stafford, not by Claude Code, which ignores
  unknown frontmatter fields.
- The delegation guardrails (depth three, no cycles, hourly ceiling, stay inside the
  project) are described in the two definitions that delegate, but Stafford is what makes
  them hold.
- The delegating definitions reference a roster capability that does not exist yet. They
  will not delegate until Stafford exposes it.

Assume a determined or confused agent ignores every line above that is not a tool
restriction, and put the real control in Stafford.

## Models

Opus for the lead developer and the code reviewer, where judgement matters most. Sonnet
elsewhere. Change these if the usage budget says otherwise: Opus on long sessions is the
fastest way to exhaust a subscription.

## Memory

`memory: project` where the knowledge is repo-specific (lead-developer, developer,
qa-tester). `memory: user` where it is about how Benzoo works (pm-assistant, code-reviewer,
writer).

## Plan file convention

Every stage reads from disk rather than from conversation:

```
docs/plans/<feature>.design.md      written by pm-assistant, confirmed by Benzoo
docs/plans/<feature>.technical.md   written by lead-developer
docs/plans/<feature>.summary.md     written by pm-assistant at the end
```

## Git

Agents branch, commit work-in-progress, and squash into one Conventional Commit per task.
They may push their own feature branch. They never push to main or master, never
force-push, and never delete a remote branch. Merging to main is Benzoo's.