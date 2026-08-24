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

This is enforced, not just stated. The `main` branch requires a review approval before any pull request can
merge, and my own account is the only bypass. So my branches still merge once CI is green, and a pull request
from a fork stays blocked until I review and approve it.

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
- Open a PR into `main`. CI has to be green: typecheck, the test suite on macOS and Windows, a packaged build
  per platform, and a secret scan. A red leg is a real signal, not a flake to rerun.

External PRs are reviewed and merged at my discretion, as above.
