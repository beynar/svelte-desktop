# Security

## Reporting a vulnerability

Report it privately, through a GitHub security advisory: [Report a vulnerability](https://github.com/beynar/svelte-desktop/security/advisories/new), or the **Security** tab of the repository, then **Report a vulnerability**. Don't open a public issue for it.

Say what's affected (the `@kitop/shell` version or commit, the OS), how to reproduce it, and what an attacker gets. The advisory stays private between you and the maintainers until a fix is out, and you're credited in it unless you'd rather not be.

## What's in scope

`@kitop/shell` in `packages/shell`: the Vite plugin, the CLI, the native shells, the updater, and what a page can reach through `bridge.allow`. `packages/push-worker` too. What's under `experiments/` and `documentation/` isn't maintained.

kitop is `0.x` and not on npm yet: fixes go into the next version, and older ones aren't patched.

What a page may call is described in [Security](website/docs/concepts/security.mdx). An app that lists `*` in `bridge.allow`, or reaches the network or files from server code on a page's request, chose that: a report about it is a report about that app.
