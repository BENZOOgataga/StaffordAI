# Changelog

All notable changes to Stafford are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Stafford aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-27

The first release with the full conversation experience and the projects layer. A colleague's work
now renders as readable blocks instead of a raw terminal, a permission gate sits in front of every
file action, and you can hand out tasks and manage projects. Still Windows only and unsigned.

### Added

- A permission gate that checks every file read, write, and edit a colleague makes before it runs,
  against the project's rules and that colleague's own overrides. A call set to ask pauses the turn on
  a banner you approve or deny in the app. Credential directories, Stafford's own data, and secret
  files are denied by default.
- A configuration screen for the gate, so you can see and edit what is allowed, asked, or denied,
  including a default profile you edit in place.
- Tasks. You can hand a colleague a task instead of a message. It runs bounded by a turn limit and a
  stop on no progress, lands its work on its own git branch, and comes back for your review instead of
  marking itself done. Sending it back with a note resumes the same session with that note as the next
  instruction.
- A Tasks board that shows every colleague's work grouped by state, so what needs you is answerable in
  one place, with a hunk-level diff viewer for reviewing what a task changed.
- A Projects tab that creates, edits, repoints, and deletes projects, shows which colleagues are bound
  to each, and parks or rebinds a colleague. A rebind starts a clean session on the new project rather
  than carrying the old context across.
- A live conversation view. A colleague's reply streams in as it is produced and renders as readable
  blocks: thinking as a collapsed block, tool calls as paired panels, shell output, file reads, and
  file edits shown as inline diffs, with a working indicator in the gap before the reply starts. A
  finished turn re-renders the same way when you reopen it.
- Answering a colleague's question from the conversation when it pauses to ask you to choose.
- A tray icon that badges when something needs you, and an OS notification when the number of things
  waiting on you goes up.

### Changed

- The interface is rebuilt. Version 0.1.0 showed each colleague as a raw terminal. Version 0.2.0 reads
  the structured event stream and renders it as blocks, so what you see is what the session did rather
  than parsed terminal text. The home dashboard, the roster, the channel, and the detail view were
  redesigned on a new component system.
- The app opens on the home dashboard instead of the roster.
- Colleague names are drawn from a fixed pool rather than typed in.
- The task turn limit is 20, paired with a stop when a turn makes no progress.

### Fixed

- A colleague could be stranded showing Working with its reply lost when a write failed part way
  through a turn. The reply and its actions now survive that.
- The message box clears when a message sends, not when the reply lands, so it is ready for the next
  one.
- The working indicator stays visible through the real gap before a reply streams.
- Colleagues no longer flag an inherited skill they cannot load.
- The detail history scrolls inside its own pane instead of moving the whole window, and the tab bar no
  longer clips its labels.
- Screen-reader announcements, a locked credential field, and per-colleague message drafts, from a
  usability pass.

### Security

- Every tool decision now routes through the gate. Some tool calls did not reach it before.
- File paths are resolved to their real absolute form, with case folded through the platform and
  symlinks followed, before any comparison, so a path cannot reach a protected directory through a case
  difference or a symlink.
- The credential directories the configuration screen marks as protected are enforced on every call
  that carries a path.
- A colleague cannot point a project at Stafford's own directory. It is refused when you set it and
  again at spawn.
- A repository can no longer leak its own settings or other directories into a colleague's session.
  Each session loads only Stafford's settings, and a colleague's inherited user memory is blanked.
- The protected and secret-file floor now also applies to MCP tools and other tool categories, not
  only to plain reads and writes.
- The shell-command deny is best-effort. Claude Code decides for itself which commands it asks about,
  so treat a shell deny as a strong default rather than a hard boundary.

## [0.1.0] - 2026-08-13

First public release. Pre-release and unsigned, cut by hand as zipped directory builds for macOS
(darwin-arm64) and Windows (win-x64), with install steps for the Gatekeeper and SmartScreen warnings in the
README.

The working core:

- Hire an agent, spawn its session, and watch it in a live terminal.
- Message a colleague and see the reply in the same window.
- A roster with one card per hire, deriving working, idle, waiting, rate limited, and crashed from Claude
  Code's own hooks.
- A channel: one timeline across every colleague, with an inline reply on the row.
- Clean drain on quit.

Not in this release: code signing, installers, and auto-update.

[Unreleased]: https://github.com/BENZOOgataga/StaffordAI/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/BENZOOgataga/StaffordAI/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BENZOOgataga/StaffordAI/releases/tag/v0.1.0
