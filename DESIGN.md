# How ogygia names things

Four words. That’s it.

Trust boundaries and “why it must stay this way” notes live in [`INVARIANTS.md`](./INVARIANTS.md).

| Word | Meaning | Code |
| ---- | ------- | ---- |
| **Page** | SSR HTML. No Kit client — ogygia runtime is a WC + router (~7.6 KB min+br). Hydrate islands put their **module URL** on `<ogygia-region entry>` (Astro-style); the sticky runtime does not embed an app-wide regions map. | `csr = false` |
| **Island** | A component that becomes interactive (gets JS). The marked import binding **is** the island (portable wrapper). | `with { hydrate: 'load' }` (or `idle` / `visible` / a media query) |
| **Lake** | Static HTML *inside* an island — no JS for that bit. Lake imports are portable wrappers too. | `with { hydrate: 'none' }` used inside an island |
| **Server island** | HTML loaded from the server later. Placeholder first. No JS. | `with { defer: 'load' }` (or `idle` / `visible` / media) |
| **Deferred client island** | HTML later, then JS on that DOM. | `with { defer: '…', hydrate: '…' }` |

`hydrate` and `defer` are the import attributes. Everything else is English.

## Portable bindings (0.4+)

```js
import A from './A.svelte' with { hydrate: 'load' };
```

`A` is a **portable island component** (virtual wrapper). Use it like any Svelte component:

- `<A start={n} />`
- `const Active = A` → `<Active {...props} />` (Svelte 5 — no `<svelte:component>`)
- `list = [{ Comp: A, props }];` + `{#each list as { Comp, props }}` → `<Comp {...props} />`

**Dedupe:** same component path + same strategy/options → one wrapper module and one client `emitFile` entry (identity is not per tag site or per host index). Multiple instances on a page share that entry URL; each instance still gets its own region + props payload at SSR (defer signing stays per-instance via props in the capability URL).

**Props** are real Svelte props into the wrapper (serialized with devalue for the region/endpoint). Put UI and lakes **inside** the island `.svelte` file — host children/snippets (except reserved `ogygiaFallback` on defer) cannot cross the boundary.

## When JS runs / when HTML arrives

Same timing words for both:

| Value | Meaning |
| ----- | ------- |
| `load` | Right away |
| `idle` | When the browser is idle |
| `visible` | When scrolled into view |
| `'(media query)'` | When the query matches |

- On an **island**, that means when JS starts.
- On a **server island**, that means when the placeholder is replaced with real HTML.
- On a **deferred client island**, `defer` is phase 1 (fetch + swap); `hydrate` is phase 2 (import + hydrate). Matching schedules coalesce: after the swap, hydrate runs immediately (no second idle / IO / MQ). `hydrate: 'load'` always means ASAP after swap. Stricter/later hydrate arms only its own schedule.

Prefer this over `{#await}` when the hole must be a real island boundary (signed endpoint, props, lakes). `{#await}` stays fine for ordinary async UI inside an already-hydrated tree.

## Live partials — `await` is the whole API

A partial renders **where it settles**. Await it on the server and it travels **with its HTML**; don’t, and it renders **where it lands** (inline, same SSR pass).

```js
export const dashboard = query.live(v.string(), async function* (id) {
  for await (const stats of feed(id)) yield partial(StatCard, { stats });
});
```

`yield` (and `return` in an async remote) awaits the value for you, so the tick carries rendered, signed HTML down the channel you already have — no client data code, no per-tick fetch. `<Partial of={dashboard(id).current} />` swaps the first tick in, then:

- **static** (`partial: 'static'`) → **morph** the HTML in place (focus / typed text / transitions survive);
- **interactive** (`partial: 'load' | …`) → **keep-alive**: push new props into the mounted island (local state survives, no re-hydrate).

One slot, always the latest tick — `.current` is one value, not a list. Want a feed? Collect partials into an array in your island and `{#each}` them.

## Sharing state across islands — `static [ogygia.wire]`

Each island is its own hydration root, so a prop crosses a **serialization** boundary (devalue), not a reference. A live class instance — a store, an orchestrator — normally can't make that jump. A class opts in by declaring how it travels:

```js
export class Cart {
  items = $state([]);
  get total() { return this.items.reduce((s, i) => s + i.price, 0); }
  add(item) { this.items.push(item); }

  static [ogygia.wire] = {
    encode: (c) => $state.snapshot(c.items),
    decode: (items) => Object.assign(new Cart(), { items }),
  };
}
```

Make one on the server, pass it to as many islands as you like — `<Badge {cart} /> <AddButton {cart} />` — and they share **one live object**. `$state` fields inside it are reactive across every island; a write in one repaints the rest. No store library, no context (context can't cross roots), no events.

- **Liveness is identity, not the codec.** Each instance mints one wire id; the browser memoizes decode by that id, so every copy of the prop reunites into the same object. Late-hydrating islands (`visible`, `idle`) join the current instance.
- **No cross-request leak.** The browser remembers decoded instances; the **server never does** — each request (and each deferred-island render) decodes fresh, so one user's state can't render into another's HTML. Make the instance per request (in your page/load), same as any prop.
- **Seed is free.** The encode snapshot rides inside the props, so SSR HTML and the client's first paint agree — no flicker.
- **`#private` stays home.** Only what `encode` returns travels, and only a `static` codec can even read `#private` — so client-only internals (abort controllers, caches) never enter the page source unless you send them.

**Constraints (loud, never silent):** a top-level `export class` in app source (the build tags it by module path + name); the receiving island must import the class as a **value** (not `import type`); `new Cls()` in a default decode must tolerate zero args. The `[ogygia.wire]` key is a registered symbol — alias it, rename the import, stash it in a `const`, it still works, because the build never reads the key, only the runtime does.

Plain module-level `$state` already shares across islands with no ceremony (one client chunk = one instance); `[ogygia.wire]` is for the case where the instance is **born on the server** and handed down as a prop.

## Streaming server islands — no new word

Streaming is not a new *when*; it is a better *how* for `defer: 'load'`. Enable `ogygia({ stream: true })` and on a dynamic page `handle()` sends the shell, then appends each hole’s server-rendered HTML down the same response as a `<template data-ogygia-slot>` parcel — zero extra requests. Prerender/CDN pages and any hole that can’t render server-side fall back to the per-hole fetch, so it never changes correctness. `idle` / `visible` / media keep fetching on schedule (deferring the *server* work is their point).

`hydrate: 'none'` with any `defer` is nonsense (HTML later and no JS) — use `defer` alone. Dev warns and treats it as defer-only.

## Nesting (one rule)

Walk up the tree. The closest marked parent decides.

| Nesting | What happens |
| ------- | ------------ |
| Island on the page | Gets its own JS |
| Island inside an island | Shares the parent’s JS (one interactive tree, not two) |
| Lake inside an island | Stays static HTML; lake JS never ships |
| Island inside a lake | Gets its own JS again |
| Server island inside an island | Renders inline with the parent (`defer` ignored) |

```
page → island → lake → island → …
```

## Client-only lazy mount (not an island)

Need JS that downloads only after a click? That is ordinary Svelte inside a host island:

```js
const Comp = (await import('./Widget.svelte')).default;
```

No `with { hydrate }` on the dynamic import — Vite strips region attributes there, and runtimes reject unknown keys. ogygia **build-errors** `import(…, { with: { hydrate|defer|preset } })` so it cannot silently no-op.

What you get is a **regular** component in the island’s tree (Vite code-splits it). It is not a second island and has no SSR shell of its own. To delay a real island until click, keep a static region import and gate `<X />` with `{#if}`.

## DOM

```html
<ogygia-region hydrate="load|idle|visible|(media)">   <!-- island -->
<ogygia-region hydrate="none">                        <!-- lake -->
<ogygia-region render="defer" when="…" endpoint="…">  <!-- server island -->
<ogygia-region render="defer" when="…" hydrate="…" entry="…module…" endpoint="…">  <!-- deferred client island -->
```
