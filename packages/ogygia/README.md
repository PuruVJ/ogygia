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
> (`none` | `load` | `idle` | `visible` | media). The nearest boundary above you wins.

```
packages/ogygia       # the library (built with tsdown to ./dist)
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
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };   // server island (fetch timing)
	import Panel    from '$lib/Panel.svelte'    with { preset: 'chart' }; // named preset
</script>

<Counter start={10} />          <!-- every usage of a marked import is a region -->
```

- **`hydrate`**: `'load'` (ASAP) · `'idle'` (`requestIdleCallback`) · `'visible'`
  (`IntersectionObserver`) · a **media query** string (`'(max-width: 600px)'` → `matchMedia`).
- **`defer`**: a **server island** (see below). Its value is the **fetch timing** for the hole,
  symmetric with `hydrate`: `'load'` (immediate, preload-hinted) · `'idle'` · `'visible'` · a media
  query. (The old boolean `defer: 'true'` is retired — use `defer: 'load'`.)
- **`preset: 'name'`**: a named preset from plugin config.
- Props flow as usual and are serialized with **devalue** (`Date`, `Map`, `Set`, `BigInt`,
  nested objects survive). Snippets/children work too; free outer-scope variables are captured
  automatically (a host binding that shadows a JS global — `const Date = …` — is captured, not
  treated as the global). Functions can't cross the boundary.
- Only `hydrate` / `defer` / `preset` are ogygia's keys. A **standard import attribute on an
  unrelated import** (`import data from './d.json' with { type: 'json' }`) is left untouched, even
  in a file that also declares islands.

**No option keys inline** — all tuning lives in plugin config:

```ts
ogygia({
	visible: { margin: '200px' },              // default IntersectionObserver rootMargin
	presets: {
		chart: { hydrate: 'visible', margin: '200px' },
		modal: { hydrate: 'idle' },
		report: { hydrate: 'none' },             // remount defaults to 'cache'
		liveReport: {
			hydrate: 'none',
			remount: { strategy: 'swr', when: 'idle' } // paint cache, then re-fetch SSR HTML
		}
	},
	rateLimit: { max: 60, windowMs: 60_000 },  // deferred-region endpoint; `false` to disable
	bindSession: 'sid'                          // opt-in: seal this cookie into the region MAC
});
```

- Inline imports only carry `hydrate` | `defer` | `preset`. Options (`margin`, `remount`, …) live in
  `presets` (or `visible.margin`). Import attributes cannot nest objects — that is why SWR timing is
  a preset object.
- `with { preset: 'chart' }` resolves the preset; presets are **tolerant** (a known-but-inapplicable
  key like `margin` on a `load` preset is ignored). Unknown preset names / unknown keys are build errors.
  A preset that sets neither `hydrate` nor `defer` is a build error.
- Build errors are precise (they name the file + import): unknown preset, an option key inline,
  `preset` mixed with another key, `defer` + `hydrate` together (roadmap). `hydrate: 'false'` errors
  with a hint to use `hydrate: 'none'` (the lake value — see below).
  Marked `hydrate`/`defer` imports that are referenced but **not** as a static `<Component>` tag
  (`<svelte:component this={…}>`, dotted `<Menu.Item>`, etc.) also error — they would otherwise be
  stripped and break the build. Completely unused marked imports are stripped silently.

## Server islands (`defer`)

A server island renders its `fallback` snippet into the page immediately; the component itself is
**not** rendered at page-SSR time. At runtime the browser fetches the rendered component from the
island endpoint (same-origin, cookies flow) and swaps it in. Props are **HMAC-signed**
(devalue payload) so the endpoint rejects tampering.

The `defer` **value** is the **fetch timing** for the hole — the same scheduler as `hydrate`, so the
two axes are symmetric:

| `defer` | when the hole fetches | preload hint? |
| ------- | --------------------- | ------------- |
| `'load'` | immediately on connect | **yes** (`<link rel="preload" as="fetch">`) |
| `'idle'` | on `requestIdleCallback` | no |
| `'visible'` | when scrolled into view (`IntersectionObserver`) | no |
| `'(media query)'` | when the query matches | no |

Only `'load'` preloads — the others deliberately hold the fetch until their schedule fires. The old
boolean spelling `defer: 'true'` is retired (build error suggesting `defer: 'load'`).

The default endpoint path is **`/🏝️ogygia🏝️`** — the island-emoji brackets make it clash-safe
against real routes. It's a handle route (not a filesystem path), so adapter-node serves it fine;
on the wire it rides as percent-encoded UTF-8 (the browser encodes it, the handle matches the
decoded pathname). Override it with `ogygiaHandle({ endpoint: '/my-islands' })`.

```svelte
<script>
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };   // or 'idle' | 'visible' | a media query
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
- Signing key: each production build bakes a **random HMAC key into the server bundle** (no setup).
  Set optional **`OGYGIA_SECRET`** (shell, CI, or `.env` / `.env.local`) when you need the same key
  across deploys — rolling updates, CDN-cached HTML, or multi-app setups. With the env set, region
  ids are also salted so they are not offline-computable. The MAC binds **region id + expiry +
  props**. Treat anything you pass into a deferred/hydrated region as public to anyone who can
  read the page HTML (HMAC is integrity, not confidentiality). The region endpoint sends
  `X-Frame-Options: DENY` / `frame-ancestors 'none'` and is rate-limited per client IP
  (configure via `ogygia({ rateLimit: { max, windowMs } })`, or `rateLimit: false` to disable).
  Rate budget for *renders* is charged **only after a valid MAC**. A separate cheaper
  probe budget runs **before** HMAC so forged floods cannot burn CPU unboundedly.
  Optional **`bindSession: 'cookieName'`** seals that cookie into the MAC so a
  harvested capability URL fails without the matching session (empty/prerender stays unbound) —
  strongly recommended for personalized holes. Capability URLs are **24h bearer tokens** embedded
  in HTML (HMAC is integrity, not confidentiality). Prefer `idle`/`visible` defer for below-fold
  holes; many `defer: 'load'` islands fan out parallel origin renders (capped client-side).
  Region HTML is inserted as trusted same-origin markup — do not put unsanitized `{@html}` from
  user input inside deferred components.
- The island component's **CSS** is collected via the page's import graph (linked in `<head>`),
  while **zero component JS** ships to the browser on a `csr = false` page.
- v1 does not hydrate after the swap (`defer` + a hydrate strategy is a roadmap combo).

## Nested regions (island in island)

An island whose own source imports another component as an island is **allowed**. Per the region
rule, a region self-hydrates iff the nearest region boundary above it is not hydrated — so the
**inner island degrades to a plain component and hydrates once, with its parent** (one hydration,
ever). A dev-only warning names the inner region. A nested **deferred** region degrades to a plain
inline component too (its `defer` is ignored; it renders with the parent — see DESIGN.md).

## Lakes (`hydrate: 'none'` inside an island)

A **lake** is a component imported with `with { hydrate: 'none' }` and used inside a hydrated
island. The lake **freezes** its subtree: it SSRs inline, but its component code ships in **no
client chunk** (the island's client module swaps the import for a placeholder), and the runtime
lifts the lake's SSR DOM out before the parent hydrates and restores it after — so no hydration
work touches it. Its contents are static by contract (props changes and events inside are inert).

```svelte
<script>
	import Board  from '$lib/Board.svelte'  with { hydrate: 'load' };  // island
	import Report from '$lib/Report.svelte' with { hydrate: 'none' };  // lake (frozen)
</script>
<Board><Report /></Board>
```

- An **island authored inside a lake self-hydrates** again — the lake reset its subtree to "dead",
  so the nearest-boundary rule wakes the inner island (alternation: shell → island → lake → island).
- **`remount`** (preset-only, with `hydrate: 'none'`) controls `{#if}` re-creation of that region:
  **`'cache'`** (default) re-inserts the SSR DOM, **`'empty'`** leaves it blank, **`'swr'`** paints
  the cache then fetches a fresh SSR from the region endpoint (`remount: { strategy: 'swr', when }`).
  Islands inside an SWR lake wait for the revalidate swap before hydrating (one wake, not cache-then-fresh).
  The browser **cannot remint** the signed endpoint after prop changes — the capability URL is whatever
  SSR minted (same 24h bearer window as deferred islands). After expiry, remount paints cache only
  until a full navigation remints. The remount DOM cache is keyed by lake entry id (bounded by unique
  lakes on the page) and cleared on SPA body swap.
- A `hydrate: 'none'` in the dead page shell is a **no-op** (dev-warned) — a plain component.
- `hydrate: 'false'` is not valid; the string value for "no hydration" is `'none'`.

## Prerendering

A `prerender = true` page ships as static HTML: normal islands hydrate from the static file, and a
**server island stays a runtime hole** — the classic "static page, personalized hole". (Remote
functions / server islands still call the server at runtime; a fully static site needs islands that
don't.)

## Classic forms & remote functions

- **Form actions** work as usual on `csr = false` pages: a plain `<form method="POST">` submits
  natively (no JS), the SPA router does not intercept it (it only handles `<a>` clicks), and
  post-redirect-get lands correctly.
- **Remote functions** work inside islands on the server (real Kit) and the client. The client
  replacement **reuses Kit's own remote primitives + wire codec** (deep-imported, no patch) plus the
  app's universal **`transport`** hook, so custom transport types and `File` args round-trip exactly
  against Kit's server. Every `.remote.ts` primitive is supported:

  | primitive | inside an island | caveats |
  | --------- | ---------------- | ------- |
  | `query` | ✓ (SSR resolves in-process; hydration seeds from the SSR result — no re-fetch) | — |
  | `query` (validated arg) | ✓ | Standard-Schema validation runs on the server |
  | `query.live` | ✓ streaming (SSE) reactive `.current` | keeps a connection open |
  | `query.batch` | ✓ N simultaneous calls collapse into **one** request | batched within a macrotask |
  | `command` | ✓ mutate + `query.refresh()` | POST needs a correct `ORIGIN` in prod (Kit CSRF) |
  | `form` | ✓ enhanced submit, field issues, no-JS fallback | see the guestbook demo |
  | `prerender` | ✓ bakes at build; on a non-prerendered page use `{ dynamic: true }` to run at request time | a non-`dynamic` prerender needs a prerendered static response |

  Both build modes (Kit-driven and standalone all-`csr=false`) support every primitive.

## Scripts

The library does **no** script processing — the only authoring vocabulary is `hydrate`/`defer`/
`preset` on imports. A nested inline `<script>` in page HTML runs on a **full document load**, as
usual. It does **not** run after a client-side (SPA) swap: newly inserted `<script>` tags don't
execute (standard browser behaviour for parsed/adopted nodes). If you need code to run per
navigation, put it in an **island**.

## SPA router

`<OgygiaRouter />` (opt-in, render it in a layout) intercepts same-origin `<a>` clicks, swaps
`<body>`, merges `<head>`, and uses View Transitions when available. Islands on the new page
hydrate via custom-element connection; old ones unmount via disconnection. Rendering `<OgygiaRouter />`
loads the runtime module, so the router works even on a page with **no islands**; the runtime module
persists across swaps. (Page inline scripts are not re-run — see above.)

### Annotation boundary (`OgygiaBoundary`)

`<OgygiaBoundary>` is an optional **transparent passthrough** exported from `ogygia`. It renders
its children and nothing else — no DOM wrapper, no nested-island context, no hydrate/render effect.
Use it only to mark a region usage in source for humans (or as a future hook point):

```svelte
import { OgygiaBoundary } from 'ogygia';
import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };

<OgygiaBoundary>
	<Counter />
</OgygiaBoundary>
```

It is **not** `<svelte:boundary>` (error/pending), and it is **not** the internal lake context
reset (`LakeBoundary` in `ogygia/internal`). Wrapping an island or lake does not change how that
region transforms or hydrates.

### Persist layout chrome (`data-ogygia-persist`)

Mark durable chrome (usually in a layout) with a stable key. On SPA navigation, if the same key
exists on the outgoing and incoming body, the **live** node is kept (SSR markup for that key is
discarded). Islands inside the persisted subtree stay mounted.

```html
<nav data-ogygia-persist="main-nav">…</nav>
```

Rules: keys must be unique per document (first wins); nested persist inside another persist
ancestor is ignored (outer wins); missing on either side → normal replace for that subtree.

### Link prefetch (`data-sveltekit-preload-*`)

The router honours SvelteKit's preload attributes to **warm its page-HTML cache** — a prefetched
page swaps in on click with **no second request**. Both attributes and Kit's value grammar +
nearest-ancestor inheritance are supported:

| value | when it prefetches |
| ----- | ------------------ |
| `eager` | immediately (on load / after each nav) |
| `viewport` | when the link scrolls into view |
| `hover` | on hover (the default when the attribute has no value) |
| `tap` | on press (mousedown / touchstart) |
| `off` / `false` | never (a nearer ancestor can disable a broader `hover`) |

Put `data-sveltekit-preload-data="hover"` on a container to opt a whole subtree in. Because this
router delivers a page's "code" via the HTML body swap (island chunks then fetch on connect),
`data-sveltekit-preload-code` maps to the **same** HTML prefetch — its extra `eager`/`viewport`
triggers just warm earlier.

Responses with `Cache-Control: private|no-store|no-cache` or `Set-Cookie` are **never** cached.
`invalidateAll()` (and successful Kit remote command/form POSTs) **bust** the cache so mutations
cannot serve stale prefetched HTML. You can also call `bust_page_cache()` from `ogygia/app`.

## Captured host state is a snapshot (don't mutate it)

Free variables an island references from host scope are **captured** and serialized with devalue —
each island receives its own **snapshot**. Writing to a captured value inside the island updates
nothing (there is no shared reactive link back to the host).

- **Build error** if island *markup* writes to a captured var — assignment, `++`, compound assign,
  destructuring-assignment, or `bind:`. The error names the variable + file and points you at the
  fix: move mutable state into the island component (`$state`), or pass an initial value and keep the
  mutable copy local.
- **Dev warning** (once per path) if the island *component* mutates a captured object/Map/Set at
  runtime — a deep Proxy around the parsed props flags it. Production ships the plain object (no
  Proxy, no warnings, zero overhead).

## Constraints

- Props must be **devalue-serializable**; functions can't cross a boundary. A non-serializable
  capture fails the SSR render with a friendly error naming the island and the offending prop path.
- Snippets can't cross a boundary (a snippet defined outside an island but used inside is a build
  error) — except the reserved server-island `fallback` snippet.
- Each island is an independent Svelte app; islands don't share reactive state.

## Build

The library builds with **tsdown** to `./dist` (`.js` + `.d.ts`); the Svelte-pipeline files
(`*.svelte`, the runes module) ship as source and are compiled by the consumer.
`pnpm --filter ogygia build`. The playground consumes the built `dist`.
