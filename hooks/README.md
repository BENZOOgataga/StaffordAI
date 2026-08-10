# Hook forwarder

One script handles every hook event. Claude Code sends the event name in the
payload, so one command registered for several events beats one script per
event, and there is a single place to change when something breaks.

> **Not registered.** As of 2026-08-07 the global registration in
> `~/.claude/settings.json` is removed, because the HTTP endpoint it posted to was deleted in
> Task 4 and every tool call was paying roughly 182ms to reach nothing. Task 5 registers six
> events per managed project instead of eight globally. A backup of the previous settings is at
> `~/.claude/settings.json.bak-before-hook-deregistration`.
>
> **Being replaced.** This JavaScript forwarder is the current implementation
> and it is on the way out. A compiled Go binary replaces it, registered per
> project rather than globally, for six events rather than eight. See
> `docs/plans/stack-migration.technical.md` sections 4.3 to 4.6. The reasoning
> and the measurements behind that are in `docs/stack-migration-verification.md`.
> This document describes what exists today.

## Install

```
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It resolves node.exe, creates a token, and prints a settings.json block to
paste. It deliberately does not edit settings.json for you.

Both the token and the paste-a-block step go away with the rewrite. The
transport becomes a local socket with per-agent secrets, and the app registers
itself into each managed project.

## Why it looks paranoid

Three constraints came out of testing on this machine, not from theory.

A hook that needs bash fails. A Claude Code session spawned inside a
pseudo-terminal does not inherit Git Bash on PATH, and the existing plugin hook
on this machine already fails at SessionStart for exactly that reason. This
script is plain Node with an absolute interpreter path.

A hook that hangs degrades every Claude Code session on the machine, not just
the dashboard. So this one has a hard 900ms ceiling and always exits 0. If the
runner is not running, sessions behave normally and the dashboard shows stale
cards, which is the right way round.

Hook payloads contain tool inputs, which means file contents, prompts and
sometimes secrets. Only the event name, session id, working directory, tool
name and notification text cross the wire. Nothing else, and no payload bodies
are written to disk.

## State comes from here, never from the terminal

The endpoint derives agent state from events: `UserPromptSubmit` means working,
`Stop` means idle, `Notification` means waiting for you. Rate limit
notifications are separated out into their own state so the queue can pause
instead of retrying.

State never comes from reading terminal output, and never from what an agent
says about itself.

`PreToolUse` also maps to working, and nothing registers it. Each hook costs a
process spawn, measured at 32ms on this machine before the forwarder does any
work at all, and registering both per-tool events adds roughly 180ms to every
tool call in every Claude Code session on the machine. The mapping stays for
anyone who registers it by hand; the registration does not.

## Config

- `AGENT_DASHBOARD_PORT`, default 4271. Chosen to sit outside the Hyper-V
  reserved TCP ranges on this machine. Check with
  `netsh interface ipv4 show excludedportrange protocol=tcp` before changing it.
- `AGENT_DASHBOARD_TOKEN`, otherwise read from `~/.agent-dashboard/token`.

## Tests

```
node --test runner/hook-endpoint.test.js
```

Six tests covering the event-to-state mapping, rate limit detection, token
rejection, activity and subagent tracking, and the health endpoint.

Three of those six do not survive the rewrite: the token test, the health route
test, and the activity and subagent test, since the token, the route and both
fields are all going. `docs/plans/stack-migration.technical.md` section 5 has
the full accounting.