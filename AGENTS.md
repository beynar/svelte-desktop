# AGENTS.md

This repository is kitop: a desktop app from a SvelteKit app, on the system's web view. `README.md` says what it is, `CONTRIBUTING.md` how to build and test it, `CLAUDE.md` the Bun conventions.

## Layout

```
packages/
  shell/          @kitop/shell, the package: the Vite plugin, the CLI (bin/kitop.ts), the runtime (src/),
                  the native shells (native/: macOS, Linux, Windows), its tests (src/**/*.test.ts, test/)
  push-worker/    the optional push service, on Cloudflare Workers
examples/
  notes/          the app most tests run against
  dashboard/, panes/   tabs, panes and a larger layout
  kit-conformance/     SvelteKit's features in the app, a closed bridge list, the build to distribute
website/          the documentation (blume): website/docs/**
.github/workflows ci.yml, windows.yml, update-test.yml
experiments/      earlier work, not kitop. experiments/gpui is a separate project with its own
                  package.json and AGENTS.md
documentation/    that project's documentation. Don't edit it
```

Each of `packages/shell`, `packages/push-worker`, `examples/*` and `website` installs on its own (`bun install` in it, its own `bun.lock`). The root `package.json` has scripts only (`bun run test`, `build`, `docs`) and no workspaces. The examples and the push worker depend on the shell through `link:`, so install `packages/shell` first.

## Commands

```sh
cd packages/shell && bun install && bun test src   # unit tests, no window
packages/shell/test/docker/run.sh platform         # Linux native suites, in Docker
packages/shell/test/docker/run.sh e2e              # Linux end to end, in Docker
packages/shell/test/docker/run.sh init             # kitop init on an existing app, its website on Node
packages/shell/test/run-platform.sh                # macOS native suites: real windows
```

`bun test` in `examples/*` and `run-platform.sh` open real windows and take the keyboard.

## Conventions

- Bun everywhere, except where the point is Node: a website built with `@kitop/shell/vite` must also build on Node, so `src/plugin.js`, `src/routes-overlay.js` and `src/host/website.js` are plain JavaScript that loads there.
- kitop reads SvelteKit's options on its setup plugin (`api.options`), which isn't public: `kitOptions()` in `src/routes-overlay.js` is the one place that does, and `src/kit-contract.test.ts` checks it.
- A change to what the package does updates `website/docs/**` and the first section of `packages/shell/CHANGELOG.md` in the same commit.
