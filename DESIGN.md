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
- `<svelte:component this={A} {...props} />`
- `list = [{ comp: A, props }];` + `{#each}` 

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
