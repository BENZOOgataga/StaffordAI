# Known issues

Things to be aware of that are not code bugs in Stafford.

## The terminal pane can show your Claude account's org domain

Claude Code renders a welcome box at the top of every session, and it includes the
logged-in account's organization, for example `you@example.com's Organization`. Stafford
streams the session's own output into the detail view's terminal pane, so whatever Claude
Code prints there is visible in Stafford.

This is Claude Code rendering your account, not anything Stafford stores or sends. The repo
itself is unaffected: this is a runtime display of the logged-in user's account, not
committed content, and the repo-level de-attribution done at publication is intact and
separate from this.

Why it matters: a screenshot, screen recording, or demo of a running session can expose the
org domain in the terminal pane. If you publish one, check the pane first or crop it. This is
your account leaking into a screenshot, not the repository leaking anything.

Stafford does not, and should not, modify or suppress Claude Code's own terminal output to
hide this. Cleaning a screenshot is the person's call, not the app's.

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
