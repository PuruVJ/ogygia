# How ogygia names things

Four words. That’s it.

Trust boundaries and “why it must stay this way” notes live in [`INVARIANTS.md`](./INVARIANTS.md).

| Word | Meaning | Code |
| ---- | ------- | ---- |
| **Page** | SSR HTML. No Kit client — ogygia runtime is a WC + router (~7.6 KB min+br). Hydrate islands put their **module URL** on `<ogygia-region entry>` (Astro-style); the sticky runtime does not embed an app-wide regions map. | `csr = false` |
| **Island** | A component that becomes interactive (gets JS). | `with { hydrate: 'load' }` (or `idle` / `visible` / a media query) |
| **Lake** | Static HTML *inside* an island — no JS for that bit. | `with { hydrate: 'none' }` used inside an island |
| **Server island** | HTML loaded from the server later. Placeholder first. | `with { defer: 'load' }` (or `idle` / `visible` / media) |

`hydrate` and `defer` are the import attributes. Everything else is English.

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

What you get is a **regular** component in the island’s tree (Vite code-splits it). It is not a second island and has no SSR shell of its own. To delay a real island boundary, keep a static region import and gate `<X />` with `{#if}`.

## DOM

```html
<ogygia-region hydrate="load|idle|visible|(media)">   <!-- island -->
<ogygia-region hydrate="none">                        <!-- lake -->
<ogygia-region render="defer" when="…" endpoint="…">  <!-- server island -->
```
