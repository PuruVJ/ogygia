<p align="center">
  <a href="https://ogygia.puruvj.dev">
    <img src="https://ogygia.puruvj.dev/favicon.svg" alt="ogygia" width="72" height="72" />
  </a>
</p>

<h1 align="center">ogygia</h1>

<p align="center">
  SSR islands for SvelteKit — no Kit patches.<br />
  <a href="https://ogygia.puruvj.dev"><strong>Docs → ogygia.puruvj.dev</strong></a>
</p>

<p align="center">
  <code>SvelteKit native</code>
  · <code>No Kit patches</code>
  · <code>SSR islands</code>
  · <code>~4.5 KB runtime</code>
  · <code>load / idle / visible</code>
  · <code>Media queries</code>
  · <code>Server islands</code>
  · <code>Lakes</code>
  · <code>Remote functions</code>
  · <code>Async Svelte</code>
  · <code>Form actions</code>
  · <code>SPA router</code>
  · <code>View Transitions</code>
  · <code>Link prefetch</code>
  · <code>Persist layout</code>
  · <code>devalue props</code>
  · <code>Import attributes</code>
  · <code>Named presets</code>
  · <code>Nesting</code>
  · <code>Prerender</code>
  · <code>csr=false HMR</code>
</p>

No Kit client bootstrap — the shared runtime is a custom element plus an optional router (~4.5&nbsp;KB min+brotli). Mark components with an import attribute; only those get their own JS. Not a new framework — it sits on SvelteKit.

## Install

```bash
pnpm add ogygia
```

```ts
// vite.config.ts — ogygia MUST come before sveltekit()
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [ogygia(), sveltekit()]
});
```

```ts
// src/routes/+layout.ts
export const csr = false;
```

Dev HMR still works with `csr = false` — soft updates for CSS and shared modules, full reload for route shells and island entry components. No extra setup; see the [docs](https://ogygia.puruvj.dev/#hmr).

## Example

```svelte
<script>
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
	import Chart from '$lib/Chart.svelte' with { hydrate: 'visible' };
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
</script>

<Counter start={10} />
<Chart />
<Greeting name="world">
	{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</Greeting>
```

That’s an **island** (JS on load), a below-the-fold island, and a **server island** (HTML fetched later). Lakes, presets, the SPA router, remotes, and the rest live in the docs:

**[ogygia.puruvj.dev](https://ogygia.puruvj.dev)**

Trust boundaries and design constraints: [`INVARIANTS.md`](../../INVARIANTS.md) in the monorepo root.
## License

MIT
