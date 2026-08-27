# Contributing

Stafford is primarily a personal project. Here is how I run it, so you know what to expect before you spend
time.

## Posture

Issues are welcome and genuinely useful, especially platform and environment bugs. Stafford talks to real
`claude` processes headless over the stream-json protocol, so a bug that only shows up on your OS, your Node
version, or your Claude Code install is exactly the kind I cannot always reproduce myself. File it.

Pull requests are welcome too, but I review them and merge at my discretion, and I do not auto-merge external
PRs. Because this is a personal project with a direction I hold in my head, a PR may sit for a while, or be
declined even when it is correct, if it does not fit where I am taking Stafford. That is not a judgement on the
work. If you want to be sure a change is wanted before you build it, open an issue first and ask.

This is enforced, not just stated. The `main` branch ruleset is active and requires one review approval and
green required checks before any pull request can merge. The only bypass is the repository admin role, which
is mine, so my own branches merge once CI is green, while a pull request from a fork, which carries no admin
role, stays blocked until I review and approve it.

## Build and run

You need Node 22 or newer and Claude Code installed.

```
npm ci
```

One thing to know: `.npmrc` sets `ignore-scripts`, so `npm ci` does not run install scripts. That is
deliberate, it keeps native modules from compiling from source without a toolchain. One step the disabled
postinstall would have done, you run yourself:

```
npm run electron:install
```

That downloads the Electron binary, which Electron no longer fetches on install. After that:

```
npm run dev        # run the app in development
npm run typecheck  # tsc across the node, preload, and web configs
npm test           # the full suite
```

## Submitting

- Branch off `main`. Never commit to `main` directly.
- Conventional Commits for messages (`feat:`, `fix:`, `docs:`, and so on).
- Keep dependencies minimal and pinned, and commit the lockfile.
- Never commit secrets.
- Open a PR into `main`. CI has to be green: the test suite (with typecheck) on macOS and Windows, a packaged
  build per platform, a secret scan over the history and the diff, and CodeQL. Treat a red leg as a real
  failure by default. The only exceptions are a short named list of known environmental flakes, and a rerun
  is only ever for a leg on that list, never a way past any other red leg. The list today is the
  `database.test.ts` WAL-timing flake and the `killTree` detached-grandchild reaping test, both timing
  sensitive on the shared CI runner and neither one something a normal diff can cause. When a leg starts
  flaking, it goes on this list as its own deliberate change, so a rerun is always against a documented
  name rather than a judgement call in the moment.

External PRs are reviewed and merged at my discretion, as above.

## Tests and types

`npm test` runs the whole suite and reports a count; a run that reports zero tests is a failure, not a pass.
`npm run typecheck` runs `tsc` across the node, preload, and web configs. Both have to be clean before a PR is
ready, and tests for non-trivial logic are part of the change, not a follow-up.

## Secrets and screenshots

Never commit a secret. There are no environment secrets to set: `.env.example` documents only optional,
non-secret development knobs, and `.env` is gitignored.

The repository contains screenshots under `docs/images/`. They come from the screenshot harness, which renders
the real renderer in a sandboxed window fed only by a synthetic stub bridge with demo data, so no real machine
state can reach the frame. If you add another screenshot, it has to come from a clean demo environment the same
way: a demo account, a neutral demo path (something like `C:\Users\you\Projects\demo`, never a real home
directory), no real repository, and crop anything that still leaks. This is the same reason a public release
must be built on a clean machine rather than a work one.
