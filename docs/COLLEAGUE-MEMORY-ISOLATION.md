# Colleague user-memory isolation: findings

Date: 2026-08-24. Investigation only, no code changed. The question: can a colleague session be
given a blank (or Stafford-controlled) user-memory slate, so it never inherits my personal
`~/.claude/CLAUDE.md`? PR #132 neutralizes one inherited instruction with an appended system-prompt
note; that is a per-instruction workaround, and any future personal content in `~/.claude/CLAUDE.md`
would leak the same way. This checked whether clean isolation is actually achievable first.

Claude Code version tested: 2.1.238. All results below are from real headless `claude` runs, not
from reading code.

## Verdict

Clean isolation is achievable today, with a supported, documented mechanism, at tiny effort and no
risk to the permission gate: the `claudeMdExcludes` setting, written into the managed `settings.json`
the seed already produces. It excludes the whole user `~/.claude/CLAUDE.md`, so it covers the entire
class of future personal-content leaks, not just the one skill instruction, and it leaves project
memory, auth, and the gate untouched.

## Branch 1: a supported memory mechanism

Yes. `claudeMdExcludes` (documented on the memory page) skips CLAUDE.md files by absolute-path or
glob pattern, and can be set at any settings layer including the user layer, which is where the
managed config dir's `settings.json` sits. Measured:

- Managed `settings.json` = `{"claudeMdExcludes":["C:/Users/Morice_L/.claude/CLAUDE.md"]}`, with
  `CLAUDE_CONFIG_DIR` pointing at that managed dir. Result: the session no longer loads
  `working-with-benzoo` (asked directly, it answered "wwb: no"), and a project-level `CLAUDE.md`
  instruction still applied (the token I planted, ZEBRA-9931, still appeared). So the user memory is
  gone and project memory is preserved.
- Path format matters: the pattern must use forward slashes (`C:/Users/.../CLAUDE.md`). A first
  attempt that also included a backslash pattern (`C:\\Users\\...`) did not match, because glob
  treats `\` as an escape. Use forward slashes only.
- Only a managed-policy CLAUDE.md (`C:\Program Files\ClaudeCode\CLAUDE.md`) cannot be excluded. The
  user file can.

This is the mechanism the other two branches were fallbacks for. It did not exist in my head during
#132 because I had not found `claudeMdExcludes`; it is the right answer.

## Branch 2: a separate OS user-profile context

No, not by environment, and not worth the heavy version. Measured:

- `os.homedir()` in Node does honor a `USERPROFILE` override (I confirmed it returns the fake path).
  But Claude Code does not resolve user memory through that: with `USERPROFILE` and `HOME` both
  redirected to a fake home that carried a forced-behavior instruction, the session ignored the fake
  home entirely (its instruction never fired) and still loaded `working-with-benzoo` from the real
  `C:\Users\Morice_L\.claude\CLAUDE.md`. So Claude Code reads the real OS profile natively on Windows,
  not from the env vars.
- A genuinely different OS user (runas / a separate profile) would give a different `~/.claude`, but
  it is a rabbit hole: it needs a real second account, cross-user ACLs so the colleague can read and
  write the project repo I own, its own git config, and its own credential placement. Large cost, and
  unnecessary now that branch 1 works. Not recommended.

## Branch 3: making `--bare` viable

No. `--bare` does drop the user memory, but its blocker is not the gate, it is authentication, and
that is worse. Measured with the real runner:

- Baseline (normal `HEADLESS_ARGS`, `--permission-prompt-tool stdio`): the gate fires. A Write tool
  call reached `can_use_tool`, my deny took effect, the file was not written, and the model reported
  BLOCKED. So the gate works exactly as designed.
- `--bare`: the session came up "Not logged in, please run /login" and never ran a tool at all.
  `--bare` skips the credential read (keychain and, here, the seeded credential file both), so a
  colleague under `--bare` cannot authenticate. The help says only `ANTHROPIC_API_KEY` works in that
  mode; OAuth and keychain are never read.
- So to use `--bare` I would have to switch colleagues from my OAuth login to an Anthropic API key,
  which is a separate key and separate billing. That is a much larger change than the workaround, for
  no benefit over branch 1. Ruled out.

I did not even reach the "does `--bare` break the gate" question, because auth failed first. Worth
recording precisely: the gate depends on `--permission-prompt-tool stdio` producing a `can_use_tool`
request (confirmed: every `--permission-mode` value instead yields `can_use_tool=false` and bypasses
the gate). `--bare` sets `CLAUDE_CODE_SIMPLE=1`; whether that alone would also defeat the prompt tool
is moot, since the credential problem already makes `--bare` a non-starter.

## What the user-memory inheritance path actually carries today

Only one thing: my `~/.claude/CLAUDE.md`, whose entire content is "load the working-with-benzoo skill
at session start." A colleague needs nothing from it. Excluding it loses a colleague nothing, and it
keeps project memory (the repo's own CLAUDE.md), which a colleague legitimately does want.

## Recommendation

Implement branch 1: have the seed write `claudeMdExcludes` into the managed `settings.json`, pointing
at my user CLAUDE.md (and, for a truly blank slate, my user `~/.claude/rules/` too), with forward-slash
paths derived from the real home. It is a few lines in the existing seed, it excludes the whole user
memory file rather than one instruction, it does not touch the gate or #125's protected dirs, it does
not break auth, and it does not touch my personal `~/.claude/CLAUDE.md`.

This supersedes #132. The appended system-prompt note was the best containment I had without
`claudeMdExcludes`; with it, the note is redundant. Close #132 and ship the exclude instead. If you
want belt and suspenders, the note can stay as well, but it is no longer load-bearing.

Bottom line: clean isolation is achievable, via `claudeMdExcludes` in the seeded managed settings.
Do that, and retire the #132 workaround.
