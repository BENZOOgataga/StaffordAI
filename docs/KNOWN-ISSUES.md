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
