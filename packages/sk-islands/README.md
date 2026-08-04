# ogygia

Astro-style **SSR islands for SvelteKit**, with **no Kit patches**. Ship a page shell with
**zero Kit JS** (`csr = false`) and hydrate only the interactive bits — each with its own
strategy — plus **server islands** (personalized holes rendered on demand).

The library depends only on `devalue`, `magic-string`, and `estree-walker`. Everything else is a
**peer** your app already provides:

| peer | range | why |
| ---- | ----- | --- |
| `@sveltejs/kit` | `>=2.70.2 <3` | ogygia **deep-imports Kit internals** (the remote wire codec, the client remote-functions entry) by absolute path — no patches, but tightly coupled to Kit's internal layout. Treat the range as **tested**: it is exercised against the pinned minor, and a Kit minor bump can move an internal we import. |
| `svelte` | `^5.40.0` | needs `createContext` (5.40+) for the nested-region flag, runes, and async SSR. |
| `vite` | `^5 \|\| ^6 \|\| ^7 \|\| ^8` | only the stable plugin API is used; broad on purpose (developed against vite 8 / Rolldown). |

> Because Kit coupling is to **internals**, minors are a tested range rather than a semver promise —
> pin Kit and bump deliberately.

> **Design:** ogygia implements the unified **region model** — see [`DESIGN.md`](../../DESIGN.md).
> Every boundary sets two axes: **`render`** (`page` | `defer`) and **`hydrate`**
> (`false` | `load` | `idle` | `visible` | media). The nearest boundary above you wins.

```
packages/sk-islands   # the library (built with tsdown to ./dist)
playground            # a SvelteKit app proving it (repo root)
```

## Install & wire up

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
// src/routes/+layout.ts — ship zero Kit JS
export const csr = false;
```

```ts
// src/hooks.server.ts — serve server islands (composes with sequence())
import { ogygiaHandle } from 'ogygia/hooks';
export const handle = ogygiaHandle();
```

> **Kit skips its client build when _every_ route has `csr === false`.** Islands need that
> client build (runtime + code-split chunks). Keep **at least one** route that doesn't set
> `csr = false` (a normal Kit page). If every route is `csr = false`, ogygia runs its own
> standalone client build automatically. Both paths are verified.

## Authoring — the region model (one import attribute)

A component becomes a **region** via a single import attribute. The block carries **exactly one**
of `hydrate`, `defer`, or `preset`. Import-attribute values must be **string literals** (ES spec).

```svelte
<script>
	import Counter  from '$lib/Counter.svelte'  with { hydrate: 'load' };
	import Chart    from '$lib/Chart.svelte'    with { hydrate: 'visible' };
	import Small    from '$lib/Small.svelte'    with { hydrate: '(max-width: 600px)' };
	import Greeting from '$lib/Greeting.svelte' with { defer: 'true' };   // server island
	import Panel    from '$lib/Panel.svelte'    with { preset: 'chart' }; // named preset
</script>

<Counter start={10} />          <!-- every usage of a marked import is a region -->
```

- **`hydrate`**: `'load'` (ASAP) · `'idle'` (`requestIdleCallback`) · `'visible'`
  (`IntersectionObserver`) · a **media query** string (`'(max-width: 600px)'` → `matchMedia`).
- **`defer: 'true'`**: a **server island** (see below).
- **`preset: 'name'`**: a named preset from plugin config.
- Props flow as usual and are serialized with **devalue** (`Date`, `Map`, `Set`, `BigInt`,
  nested objects survive). Snippets/children work too; free outer-scope variables are captured
  automatically. Functions can't cross the boundary.

**No option keys inline** — all tuning lives in plugin config:

```ts
ogygia({
	visible: { margin: '200px' },              // default IntersectionObserver rootMargin
	presets: {
		chart: { hydrate: 'visible', margin: '200px' },
		modal: { hydrate: 'idle' }
	}
});
```

- `with { preset: 'chart' }` resolves the preset; presets are **tolerant** (a known-but-inapplicable
  key like `margin` on a `load` preset is ignored). Unknown preset names / unknown keys are build errors.
- Build errors are precise (they name the file + import): unknown preset, an option key inline,
  `preset` mixed with another key, `defer` + `hydrate` together (roadmap), `hydrate: 'false'`
  (lakes, roadmap).

## Server islands (`defer: 'true'`)

A server island renders its `fallback` snippet into the page immediately; the component itself is
**not** rendered at page-SSR time. At runtime the browser fetches the rendered component from the
`/_islands` endpoint (same-origin, cookies flow) and swaps it in. Props are **HMAC-signed**
(devalue payload) so the endpoint rejects tampering.

```svelte
<script>
	import Greeting from '$lib/Greeting.svelte' with { defer: 'true' };
</script>

<Greeting name="world">
	{#snippet fallback()}<p>loading…</p>{/snippet}
</Greeting>
```

```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { ogygiaHandle } from 'ogygia/hooks';
export const handle = sequence(ogygiaHandle(), myOtherHandle);
```

- The component runs **server-side during a deferred render** — remote functions, `await`, and
  cookies all work with the request context of the island fetch.
- A `<link rel="preload" as="fetch">` hint starts the fetch during HTML parse (the runtime fetch
  reuses it — one server render). Skipped when prerendering.
- Signing key: `process.env.OGYGIA_SECRET` if set, else a per-build key baked into the
  **server** bundle only (never a client chunk).
- The island component's **CSS** is collected via the page's import graph (linked in `<head>`),
  while **zero component JS** ships to the browser on a `csr = false` page.
- v1 does not hydrate after the swap (`defer` + a hydrate strategy is a roadmap combo).

## Nested regions (island in island)

An island whose own source imports another component as an island is **allowed**. Per the region
rule, a region self-hydrates iff the nearest region boundary above it is not hydrated — so the
**inner island degrades to a plain component and hydrates once, with its parent** (one hydration,
ever). A dev-only warning names the inner region. A nested **server** island degrades to a plain
inline component too (its `defer` is ignored until lakes land — see DESIGN.md).

## Prerendering

A `prerender = true` page ships as static HTML: normal islands hydrate from the static file, and a
**server island stays a runtime hole** — the classic "static page, personalized hole". (Remote
functions / server islands still call the server at runtime; a fully static site needs islands that
don't.)

## Classic forms & remote functions

- **Form actions** work as usual on `csr = false` pages: a plain `<form method="POST">` submits
  natively (no JS), the SPA router does not intercept it (it only handles `<a>` clicks), and
  post-redirect-get lands correctly.
- **Remote functions** (`.remote.ts` `query`/`command`/`query.live`) work inside islands on the
  server (real Kit) and the client. The client replacement **reuses Kit's own wire codec**
  (deep-imported, no patch) plus the app's universal **`transport`** hook, so custom transport
  types and `File` args round-trip exactly against Kit's server. `command` (POST) needs a correct
  `ORIGIN` in production (Kit CSRF). Remote `form()` inside islands is **not yet implemented** —
  use form actions (see TODO.md).

## Scripts

The library does **no** script processing — the only authoring vocabulary is `hydrate`/`defer`/
`preset` on imports. A nested inline `<script>` in page HTML runs on a **full document load**, as
usual. It does **not** run after a client-side (SPA) swap: newly inserted `<script>` tags don't
execute (standard browser behaviour for parsed/adopted nodes). If you need code to run per
navigation, put it in an **island**.

## SPA router

`<ClientRouter />` (opt-in, render it in a layout) intercepts same-origin `<a>` clicks, swaps
`<body>`, merges `<head>`, and uses View Transitions when available. Islands on the new page
hydrate via custom-element connection; old ones unmount via disconnection. Our runtime module
script lives in `<head>` and persists across swaps. (Page inline scripts are not re-run — see above.)

## Constraints

- Props must be **devalue-serializable**; functions can't cross a boundary.
- Snippets can't cross a boundary (a snippet defined outside an island but used inside is a build
  error) — except the reserved server-island `fallback` snippet.
- Each island is an independent Svelte app; islands don't share reactive state.

## Build

The library builds with **tsdown** to `./dist` (`.js` + `.d.ts`); the Svelte-pipeline files
(`*.svelte`, the runes module) ship as source and are compiled by the consumer.
`pnpm --filter ogygia build`. The playground consumes the built `dist`.
