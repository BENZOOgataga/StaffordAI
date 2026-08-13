# Changelog

All notable changes to Stafford are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Stafford aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/BENZOOgataga/StaffordAI/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BENZOOgataga/StaffordAI/releases/tag/v0.1.0
