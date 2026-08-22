# Known issues

Things to be aware of that are not code bugs in Stafford.

## A running session can carry your Claude account or environment into a screenshot

The headless migration removed the pty terminal pane, so the Claude Code TUI welcome box, the
one that printed `you@example.com's Organization`, no longer renders inside Stafford. That
specific leak is gone. The general caution still holds. The Transcript and Conversation views
show a colleague's own session content, and a colleague can print an account or path identifier
into its output, so a screenshot of a live session can still carry something you did not mean to
publish.

This is runtime display of the logged-in account and the environment, not anything the repo
stores or sends. The repo itself is unaffected, and the repo-level de-attribution done at
publication is intact and separate from this.

Why it matters: a screenshot, screen recording, or demo of a running session can expose an
account or a path. If you publish one, check the views first or crop them. This is your account
or environment leaking into a screenshot, not the repository leaking anything.

The same caution covers the dev environment, not just the Claude account. On a work machine
the shell prompt and the terminal tab titles can carry an employer identifier (a company name
in the path or the window title). That is the environment, not Stafford and not the repo, but
it lands in a screenshot the same way. Any public screenshot for the README, a demo, or a
release must come from a clean environment or be cropped, or it quietly undoes the repo-level
de-attribution that is otherwise intact.

## The Windows build is auto-signed with whatever cert is on the machine

electron-builder signs the packaged Windows binary with `signtool`, using a code-signing
certificate present on the build machine. On a work PC that can be a work-issued cert, and a
public release signed with it would carry an employer association into the artifact, which is
the same kind of leak as the screenshots above, baked into the download rather than a picture.

Before cutting the Windows release, confirm which certificate signs the build, and if it is a
work-issued or otherwise identifying cert, build the release artifact on a clean machine (or
with signing configured to a cert meant for public release). This is a release-time check, not
a code change.

## A colleague session no longer loads the user's global plugins (fixed)

Earlier, a colleague session inherited the user's global `~/.claude`, so their personal
plugins and hooks loaded into it. With plugins that hard-require bash (the superpowers plugin)
this printed red `SessionStart:startup hook error` lines, and worse combinations left the
session in manual mode with a message that never submitted.

Fixed: a colleague now runs against a Stafford-managed config directory under userData, pointed
to by `CLAUDE_CONFIG_DIR`, seeded per spawn with the user's credential, the project's trust, and
plugin-free settings. The user's global plugins and hooks are off the read path by construction,
so a colleague comes up clean and in the normal auto mode even when the user has plugins enabled
for their own work. Stafford's own state-reporting hook is registered in the project, not the
user config, so it still fires. `--safe-mode` was deliberately not used: it would also disable
Stafford's own hook.

macOS caveat, owed on the Mac: on macOS the credential lives in Keychain (global), not in a
file under `~/.claude`, so the seed has nothing to copy and the managed dir is expected to
authenticate through Keychain with no copy. This is structured for (the copy is conditional on
the credential file existing) but not yet verified on a real Mac. See the runbook in
`docs/HANDOFF.md`.

## A shell deny is best-effort, because Claude Code does not put every command through the gate

Stafford's permission gate sits at `can_use_tool`. That is the right seam and it works: a
denied write is refused, a rule set to ask pauses the turn until you answer, and a protected
path is unreachable. It is only a boundary for the calls Claude Code actually sends to it.

Measured on 2026-08-22 against Claude Code 2.1.237. With a rule denying the whole `shell`
category, a colleague ran `echo asked` and it succeeded. The wire log shows why: between the
`tool_use` and its `tool_result` there is no `control_request` at all, while a `Write` in the
same session did produce one. Claude Code decided for itself that the command needed no
permission and never asked. A compound command in the same run (`ls -la && tail -c 20 README.md
| xxd | tail -2`) was put to the gate normally.

So a category-level shell rule stops the commands Claude Code considers worth asking about, and
does not stop the ones it does not. Treat it as a strong default rather than a containment
boundary, and do not rely on it to keep a colleague away from something that matters.

This is Claude Code's behaviour, not a defect in the gate, and Stafford cannot close it from
where it sits. It matters more now that tasks run unattended, since nobody is watching the
commands go by.

What still holds, and is worth being clear about because it is what the security model actually
rests on:

- File reads and writes go through the gate, so path scopes, the protected `userData` directory
  and the secret-file patterns are enforced on the calls that carry a path.
- A command that is put to the gate is resolved against the full rule set as normal, including
  the destructive-command patterns.
- A task result branch never contains an untracked file the colleague did not name, and never
  one matching a secret pattern, so a command that writes a secret to disk still cannot get it
  onto a branch you push.

If you need a hard boundary on what a colleague can execute, it has to come from outside Claude
Code: run the colleague against a repository on a machine or in a container where the dangerous
thing is not reachable.
