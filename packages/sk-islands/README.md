# sk-islands

Astro-style **SSR islands for SvelteKit**, with **no Kit patches**. Ship a page shell
with **zero Kit JS** (`csr = false`) and hydrate only the interactive bits ("islands"),
each with its own strategy (`load` / `visible` / `media` / `idle`).

Built for **Svelte 5.56+** and **SvelteKit 2.70+**. The library depends only on
`devalue`, `magic-string`, and `estree-walker` (`svelte` is a peer).

```
packages/sk-islands   # the library
playground            # a SvelteKit app proving it (see the repo root)
```

## Install & wire up

```js
// vite.config.js — sk-islands MUST come before sveltekit()
import { sveltekit } from '@sveltejs/kit/vite';
import { skIslands } from 'sk-islands/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [skIslands(), sveltekit()]
});
```

```js
// src/routes/+layout.js — ship zero Kit JS
export const csr = false;
```

> **Important — Kit skips the client build when _every_ route has `csr === false`**
> (`kit/src/exports/vite/index.js`: `skip_client_build = nodes.every(n => n.page_options?.csr === false)`).
> Islands need that client build (their runtime + code-split chunks live there). Keep **at
> least one route** that does not set `csr = false` (a normal Kit-hydrated page is fine; the
> playground uses `/kit`). Island pages themselves stay `csr = false` and ship no Kit bootstrap.

## Three ways to declare an island

All three flow through **one hoisting pipeline** (extract subtree → free-variable
analysis → generate a virtual `.svelte` island module → SSR it + emit a hydration
custom element). Props are serialized with **devalue**, so `Date`, `Map`, `Set`,
`BigInt`, and nested objects survive to the client.

### 1. Import attribute (per-file, editor-clean)

```svelte
<script>
	import Counter from '$lib/Counter.svelte' with { island: 'load' };
</script>
<Counter start={10} />   <!-- every usage becomes an island -->
```

`island` value: `'load'` | `'visible'` | `'idle'` | a **media query** string
(`'(max-width: 600px)'` → `media`). The `with { … }` clause is stripped from the emitted
host script. TypeScript 5.3+ accepts arbitrary import-attribute keys with `module: esnext`.
_Tradeoff:_ the marked import must be used only in markup (the whole import is removed from
the host).

### 2. `<Island>` wrapper (most flexible — arbitrary mixed content)

```svelte
<script>
	import { Island } from 'sk-islands';
</script>

<Island visible>              <!-- visible | idle | media="(…)" | load (default) -->
	<Comp a={x} b={new Date()}>
		{#snippet header()}<h2>{title}</h2>{/snippet}
		<p>children {y}</p>
	</Comp>
</Island>
```

Props "as usual", snippets "as usual". Outer-scope variables referenced inside the island
(script vars, `{#each}` locals, …) are captured and serialized as props automatically.

### 3. Filename convention (global, zero editor noise)

Any component imported from a `*.island.svelte` file is an island at **every** use site.

```svelte
<!-- Clock.island.svelte -->
<script module>
	export const island = 'load'; // optional override; default is 'load'
</script>
```

_Tradeoff:_ strategy is per-component (via `export const island`), **not** per-use-site.

**Rejected on purpose** (they parse, but hurt DX): `<Comp client:visible>` /
`<Comp island="visible">` (svelte-check flags unknown props) and `?island` query imports
(needs ambient type shims).

## Hydration strategies

- `load` — hydrate ASAP (default)
- `visible` — `IntersectionObserver`; pass a string for a `rootMargin` (wrapper: `<Island visible="200px">`)
- `media` — `matchMedia`, e.g. `media="(max-width: 600px)"`
- `idle` — `requestIdleCallback` (falls back to `setTimeout`)

## SPA router (Astro ClientRouter-style)

Enabled by default (`skIslands({ spa: false })` to disable). Intercepts same-origin `<a>`
clicks, fetches the page, swaps `<body>`, merges `<head>`, and updates history — with
**View Transitions** when available. Islands on the new page hydrate via custom-element
connection; old ones `unmount` via disconnection.

- Skips: modified clicks, `target`, `download`, `rel="external"`, `data-no-spa`, `data-sveltekit-reload`.
- Prefetch on hover/tap under `data-sveltekit-preload-data="hover|tap"`.
- Scroll position is saved in `history.state` and restored on back/forward.
- **Scripts across swaps** (DOM-inserted scripts don't auto-run): module `src` scripts run
  once per URL; classic `src` scripts re-run each swap; **inline** scripts re-run only with
  `data-rerun`; scripts identical to the previous page never re-run.

Authored **plain scripts** (must be nested inside an element — a markup-level second
`<script>` is treated by Svelte as a component script):

- **Inline** `<script>…</script>` — SSR'd verbatim, runs on first load. On SPA arrival it
  does NOT re-run unless it has **`data-rerun`**.
- **Bundled** `<script island>…</script>` — extracted into its own module chunk (its
  imports resolve & bundle), replaced with `<script type="module" src="…">`. The module URL
  is de-duped across SPA navigations (runs once), like Astro's default `<script>`. Add
  `lang="ts"` for TypeScript.

## Async + SvelteKit remote functions in islands

Islands can use **async Svelte** (`await` in `<script>`/markup, `<svelte:boundary>`) and
**remote functions** (`.remote.ts` with `query`/`command`/`query.live` from `$app/server`),
**on the server AND the client**.

- `await` **outside** a pending boundary → resolved data is in the SSR HTML.
- `await` **inside** a `<svelte:boundary>` with a `pending` snippet → SSR renders `pending`,
  then the client fetch resolves it after hydration.
- `query(arg)` returns a reactive resource: `await it`, read `.current`/`.loading`/`.error`,
  and call `.refresh()`.
- `command(arg)` POSTs to the server; combine with `query.refresh()` to show mutations.
- `query.live(...)` streams over SSE; read `.current` for live updates.

**How it works (client, under `csr = false`):** Kit's own client remote runtime needs `app`
(transport/encoders/decoders), which is set only by `start()` — never called when the shell
ships no Kit JS. So on the CLIENT build sk-islands replaces Kit's `__sveltekit/remote` with
its own client that talks to the **same** Kit server endpoints
(`<base>/<appDir>/remote/<id>`) using the same wire format (base64url(devalue) payload,
`{ type:'result', data: devalue({ _: value }) }` response). SSR still uses real Kit.

Caveats:
- **`command` (POST) needs a correct origin in production.** Kit rejects cross-origin remote
  POSTs (CSRF). With `adapter-node`, set `ORIGIN` (e.g. `ORIGIN=https://example.com`). GET
  queries and `query.live` are unaffected; dev skips the check entirely.
- **Custom `hooks.transport` types are not supported** by the island remote client (built-in
  devalue types — Date/Map/Set/BigInt/… — round-trip fine). `form` is not implemented.
- `kit.appDir` is assumed to be the default `_app`.

## Compat shims for messy real-world patterns

Because Kit's client runtime is absent under `csr = false`, these are aliased for island code:

| Import | Behaviour in islands |
| --- | --- |
| `$app/state` `page` | Reactive-ish `page` seeded from a per-island SSR snapshot (`window.__skIslandsPage`), re-seeded on every SPA swap. `page.data` must be **devalue-serializable**. |
| `$app/stores` `$page` | Readable store over the same snapshot. |
| `$app/navigation` | `goto`→SPA nav; `invalidate`/`invalidateAll`→re-fetch+re-render current URL; `beforeNavigate`/`afterNavigate`→router events; `preloadData`/`preloadCode`→warm the HTML cache; `disableScrollHandling`→no-op (dev warns); `pushState`/`replaceState` shallow routing→unsupported (warns). |
| `sk-islands/app` | The same navigation API, importable from **any** island component (always reliable — see below). |

**How the `$app/*` alias is applied (and its limit).** Kit resolves `$app/*` via a vite
alias that runs before plugin `resolveId`, so we rewrite `$app/*` import specifiers **in the
generated island virtual module source** at load time (client build only; SSR keeps real
Kit). That reliably covers imports that land in the island module — i.e. **host imports
referenced at the `<Island>` boundary**:

```svelte
<script>
	import { page } from '$app/state';
	import OrderDetail from '$lib/OrderDetail.svelte';
</script>
<Island load>
	<OrderDetail id={page.params.id} order={page.data.order} />
</Island>
```

A `$app/*` import **deep inside** a regular component that an island uses is _not_ reliably
aliased (that module can also be reached from a normal CSR page, so it can't be rewritten
per-consumer). For navigation from such components, import from **`sk-islands/app`**
instead of `$app/navigation` (used by the playground's `FilterBar`). For page data, prefer
passing it as props from the boundary (works everywhere, always devalue-safe).

## Constraints

- **Props must be devalue-serializable.** Functions can't cross the island boundary.
- **Snippets can't cross the boundary.** A snippet defined outside an island but referenced
  inside is a build-time error; define it inside the island.
- **No cross-island reactivity.** Each island is an independent Svelte app; they don't share
  state. Two islands with the same component are two independent instances.
- `page.data` used via the shim must be devalue-serializable (it's snapshotted per island).

## Options

```js
skIslands({ spa: true }); // spa: false disables the built-in router
```
