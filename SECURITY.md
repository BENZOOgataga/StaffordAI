# Security policy

Stafford is pre-release, and its core works and is in use. It runs Claude Code agents with real permissions on
the machine it is installed on, so I take its security surface seriously, and I want reports as the project
opens to contributions.

## Reporting a vulnerability

Email `contact@benzoogataga.com` with what you found and how to reproduce it. Please do not open a
public issue for a security problem before it has been addressed.

There is no bug bounty and no committed response time. This is a single-maintainer project and reports
are handled on a best-effort basis.

## Scope

In scope: the runner, the hook transport, the process and sandbox handling, the IPC surface between the
Electron main process and the renderer, and the update mechanism once it exists.

Out of scope: findings in upstream dependencies (report those upstream), and issues that require an
attacker to already control the machine Stafford runs on, since Stafford runs as the user and does not
defend against a compromised host.

## A note on the Claude Code sandbox

Stafford's design treats one class of risk as settled rather than open: configuration that governs how
an agent session runs is not writable by an agent, because a containment boundary a contained process
can reconfigure from inside is not containment. A specific instance of this shape was reported to the
Claude Code maintainers separately. If you find something in the same class, it is likely already known;
report it anyway so it can be confirmed.
