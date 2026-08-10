# Stafford

A local desktop app that turns Claude Code into a team you manage instead of a terminal you
use.

You hire agents. Each one takes a role from a definition file and gets a generated name you
cannot change, because you do not choose the name of someone you hire. They persist across
sessions with their history intact. You open the app and see a roster of cards, one per
hire, showing who is working, who is idle and who is waiting on you. Clicking a card gives
that agent's live terminal and a box to type into, which is the CLI you already know,
addressed to a specific person.

Named after Stafford Beer, the cybernetician. The name is load bearing: this is a variety
management system for agents, not a task tracker.

## The axis

Vibe Kanban is task-centric. The Claude Desktop app is session-centric. Stafford is
people-centric. You talk to a colleague, and the board is a view on top of that rather than
the point of it.

## Status

Early. Not usable yet, and not installable yet.

| Piece                                              | State                                    |
| -------------------------------------------------- | ----------------------------------------- |
| Hook forwarder and state derivation                 | Working, tested against real sessions      |
| Agent environment, binary locator, trust reading    | Working, tested                            |
| Pseudo-terminal sessions                            | Working, tested                            |
| Migration to a TypeScript Electron app              | Planned, in progress                       |
| Roster, terminal view, the rest of the interface    | Not started                                |
| Installers, signing, auto-update                    | Not started                                |

The current tree is mid-migration. What exists runs on Node as a headless runner; what is
being built is an Electron desktop app that keeps the same logic and replaces the shell
around it.

## How it works

Agent state comes from Claude Code's own hooks, never from reading terminal output and never
from what an agent says about itself. A small forwarder posts a minimal summary of each hook
event to a local endpoint, which derives idle, working, waiting, rate limited and crashed
from the event stream.

Each agent runs as a real `claude` process inside a pseudo-terminal. The terminal is
streamed to the interface and typed input goes back to its stdin. Nothing parses the
terminal.

Tool restriction is enforced by Claude Code through each definition's `tools` allowlist,
which is the only mechanism that actually holds. Project policies can narrow that allowlist
and can never widen it.

## Documentation

The design is the documentation, and it is kept current rather than written once.

| Document                                     | What it covers                                                    |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `docs/plans/STAFFORD-PLAN.md`                 | The whole intended system, including what was tried and rejected    |
| `docs/plans/STACK-DECISION.md`                | The stack, and why Electron rather than Tauri or a browser page     |
| `docs/plans/pty-runner.technical.md`          | The pseudo-terminal layer                                           |
| `docs/plans/stack-migration.technical.md`     | Moving to TypeScript and Electron                                   |
| `docs/pty-runner-verification.md`             | Measured results, with the raw output                               |
| `docs/stack-migration-verification.md`        | The same, for the migration                                         |
| `docs/agents/`                                | The six role definitions                                            |
| `hooks/README.md`                             | The hook forwarder as it exists today                               |

The verification documents carry real output rather than summaries, including the results
that contradicted an earlier assumption. A decision that was corrected is recorded with the
correction, not quietly rewritten.

## Requirements

- Node 26. `node --test runner/*.test.js`, no test framework.
- Claude Code, native installer.
- Windows 11 or macOS. Both are first-class targets. Linux is written but unsupported and
  the app refuses to start there rather than half working.

## Tests

```
npm test
```

Tests for non-trivial logic are part of done. A run reporting zero tests is a failure, not a
pass.

## Contributing

This is an early, single-maintainer project and it is not actively seeking external contributions
yet. Bug reports and questions are welcome as issues. If that changes, this section will say so.

Security issues go to `contact@benzoogataga.com` rather than to a public issue. See `SECURITY.md`.

The conventions the project follows internally, for anyone reading the history: branch before work,
never commit to `main`, Conventional Commits, minimal dependencies pinned with the lockfile committed,
and never commit secrets.

## Licence

Copyright (C) 2026 BENZOOgataga.

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). The full text is in
`LICENSE`.
