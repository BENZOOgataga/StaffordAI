# Stafford

Stafford is a local desktop app that turns Claude Code into a team you manage instead of a terminal you use.

You hire agents. Each one takes a role from a definition file and gets a generated name you cannot change,
because you do not choose the name of someone you hire. They persist across sessions with their history
intact. You open the app and see a roster of cards, one per hire, showing who is working, who is idle, and who
is waiting on you. Clicking a card gives you that agent's live terminal and a box to type into, which is the
CLI you already know, addressed to a specific person.

I named it after Stafford Beer, the cybernetician. The name carries weight: this is a variety management
system for agents, not a task tracker.

## The axis

Vibe Kanban is task-centric. The Claude Desktop app is session-centric. Stafford is people-centric. You talk
to a colleague, and the board is a view on top of that rather than the point of it.

## Status

Pre-release. The core works and I use it, but there is no signed installer yet, so you run it from an unsigned
build (see Install below).

What works today:

- Hire an agent, spawn its session, and watch it in a live terminal.
- Message a colleague, and see the reply in the same window.
- A roster with one card per hire, deriving working, idle, waiting, rate limited, and crashed from Claude
  Code's own hooks.
- A channel: one timeline across every colleague, with an inline reply on the row.
- Clean drain on quit, so no session is left half torn down.

What is not done yet: code signing, installers, and auto-update. That is the release work in progress now, and
it is why the current build is unsigned.

## Platforms

v0.1.0 is Windows only. Windows is my daily platform and the one I verify on, so it ships first. macOS is
written and builds, but I develop on Windows and verifying macOS means switching machines, so I am not gating
the first release on it. It comes in a later release. Linux is written but unsupported, and the app refuses to
start there rather than half working. The macOS install steps are kept below under a planned note so the
knowledge is not lost.

## Install

v0.1.0 is Windows only. There is no code signing yet, so the binary is unsigned, and Windows SmartScreen warns
you the first time you open the app. You approve it once. This is expected for an unsigned build, not a sign
anything is wrong.

Download `Stafford-0.1.0-win-x64.zip` from the [latest release](https://github.com/BENZOOgataga/StaffordAI/releases/latest),
unzip it, and follow the steps below. There is no installer; you run the app from the unzipped folder.

### Windows

1. Unzip `Stafford-0.1.0-win-x64.zip`. You get a `Stafford-0.1.0-win-x64` folder.
2. Open the folder and run `Stafford.exe`.
3. Windows SmartScreen will stop it with "Windows protected your PC" and say it prevented an unrecognized app
   from starting, because the app is unsigned.
4. Click **More info**, then **Run anyway**.
5. Stafford starts in the tray. It runs from the tray with no window until you open it.

You approve it once. Windows remembers the choice for that copy.

### macOS (planned, not in v0.1.0)

macOS is not shipped in v0.1.0. These steps are kept for when it lands in a later release, and describe the
unsigned launch as it worked in development.

1. Unzip `Stafford-<version>-darwin-arm64.zip` and move `Stafford.app` to Applications.
2. Open it. Because the app is unsigned and not notarized, macOS Gatekeeper blocks the first launch and says it
   cannot verify the developer.
3. On recent macOS, open **System Settings > Privacy & Security**, scroll to the message about Stafford being
   blocked, and click **Open Anyway**, then confirm. On older macOS, right-click the app, choose **Open**, and
   confirm **Open** in the dialog.
4. Stafford starts in the menu bar.

You approve it once per copy.

If you would rather build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

Agent state comes from Claude Code's own hooks, never from reading terminal output and never from what an
agent says about itself. A small forwarder posts a minimal summary of each hook event to a local endpoint,
which derives idle, working, waiting, rate limited, and crashed from the event stream.

Each agent runs as a real `claude` process inside a pseudo-terminal. The terminal is streamed to the interface
and typed input goes back to its stdin. Nothing parses the terminal.

Tool restriction is enforced by Claude Code through each definition's `tools` allowlist, which is the only
mechanism that actually holds. Project policies can narrow that allowlist and can never widen it.

## Documentation

The design is the documentation, and I keep it current rather than writing it once.

| Document                                     | What it covers                                                    |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `docs/plans/STAFFORD-PLAN.md`                 | The whole intended system, including what I tried and rejected      |
| `docs/plans/STACK-DECISION.md`                | The stack, and why Electron rather than Tauri or a browser page     |
| `docs/plans/pty-runner.technical.md`          | The pseudo-terminal layer                                           |
| `docs/plans/stack-migration.technical.md`     | Moving to TypeScript and Electron                                   |
| `docs/pty-runner-verification.md`             | Measured results, with the raw output                               |
| `docs/stack-migration-verification.md`        | The same, for the migration                                         |
| `docs/agents/`                                | The six role definitions                                            |
| `hooks/README.md`                             | The hook forwarder as it exists today                               |

The verification documents carry real output rather than summaries, including the results that contradicted an
earlier assumption. When I corrected a decision, I recorded the correction rather than quietly rewriting it.

## Requirements

- Node 22 or newer. CI runs on 26.
- Claude Code, native installer.
- Windows 11 for v0.1.0. macOS comes in a later release.

## Tests

```
npm test
```

Tests for non-trivial logic are part of done. A run reporting zero tests is a failure, not a pass.

## Issues and contributing

File bugs and feature requests as [issues](https://github.com/BENZOOgataga/StaffordAI/issues). Platform and
environment bugs are especially useful to me.

This is primarily a personal project. I welcome pull requests, but I review them and merge at my discretion,
and I do not auto-merge external PRs. A PR may sit or be declined if it does not fit the direction. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build, run, and submit.

Security issues go to `contact@benzoogataga.com` rather than to a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Copyright (C) 2026 BENZOOgataga.

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). The full text is in
[`LICENSE`](LICENSE).
