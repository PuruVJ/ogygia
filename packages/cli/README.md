# @ogygia/cli

The [ogygia](https://ogygia.puruvj.dev) command line: project and docs-site setup, the AI skill and MCP server, perf budgets, and federation keys and catalogs.

## Install

You rarely install it yourself. The `ogygia` package's `ogygia` command runs it: the app's installed copy, or the matching version through your package manager.

```bash
npx ogygia init          # wire ogygia into a SvelteKit app
```

To pin it, add it beside `ogygia`:

```bash
pnpm add -D @ogygia/cli
```

It is not a plugin: nothing goes in vite.config for it.

## Commands

- `ogygia init` (`--markdown` adds content) and `ogygia site init`: set up an app, or a docs site.
- `ogygia ai`: install the ogygia skill and register the MCP server for AI agents. `ogygia mcp` runs the server.
- `ogygia perf`: render pages under the profiler and judge them against a budget in CI.
- `ogygia keys <name>`: make an Ed25519 key pair for federation. `ogygia fragments <origin>`: typed stubs for a peer's widgets.

Docs: [ogygia.puruvj.dev](https://ogygia.puruvj.dev).
