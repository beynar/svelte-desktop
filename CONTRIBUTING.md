# Contributing

kitop is `packages/shell`. Each folder installs on its own with Bun: there are no workspaces, and nothing at the root is needed to work on it.

## What you need

- [Bun](https://bun.sh) 1.4 or newer. CI runs 1.4.4.
- On macOS, the Xcode command line tools (`xcode-select --install`).
- Docker, for the Linux suites and for building Windows from macOS or Linux.

## Build and run

There's nothing to compile ahead of time: the package is its sources. The native shell builds itself the first time an app runs or builds.

```sh
cd packages/shell && bun install
cd ../../examples/notes && bun install
bun run dev      # a native window, with hot reload
bun run build    # the app, in .desktop/dist
```

The examples depend on `packages/shell` through a `link:`, so they run your changes as you make them. Install the shell first: its own dependencies are in its folder.

`bun run build` at the root packs the package, `dist/kitop-shell-<version>.tgz`, the way it would be published. `bun run docs` runs the documentation site.

## Test

```sh
cd packages/shell
bun test src                       # unit tests, no window
test/docker/run.sh platform        # the Linux native suites, in Docker
test/docker/run.sh e2e             # Linux end to end: the examples, real updates, the packed tarball
test/docker/run.sh init            # kitop init on an app made by sv create, its website on Node
test/run-platform.sh               # the macOS native suites: real windows
```

`bun test` in `examples/*` and `test/run-platform.sh` open real windows and take the keyboard: run them when you aren't using the machine, or leave them to CI. What runs where is in `.github/workflows`: `ci.yml` (unit tests on Ubuntu and macOS, the macOS native suites and built apps, the Linux suites in Docker), `windows.yml` (the Windows build and its end to end on a Windows runner) and `update-test.yml` (real updates on macOS and Windows).

## Changes

- Match the code around yours: short, with comments that say why.
- A fix comes with a test that fails without it.
- Docs change in the same commit as the code: `website/docs`, and a line in the first section of `packages/shell/CHANGELOG.md`. [Versions and breaking changes](website/docs/reference/versioning.mdx) says what counts as breaking.
- `experiments/` and `documentation/` hold an earlier project. Leave them be.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
