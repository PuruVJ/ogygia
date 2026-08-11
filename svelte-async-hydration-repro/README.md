# Control: neither Svelte nor ogygia's hydration envelope reflows in isolation

## Round 2 (hero-bounce investigation) — the ENVELOPE is exonerated too

The hero "bounce" on the docs homepage is a one-frame layout reflow: an async island (the sidebar,
`await docNav()`) transiently shoves downstream content during hydration. This repro was extended to
measure LAYOUT (host height + a sibling's `top`, frame-by-frame) instead of just `class`, across every
axis that differs from a plain component:

- async component (top-level `await`) — **clean** (sibling delta 0px)
- + `position: fixed` content (host has 0 flow height at rest, like the sidebar) — **clean**
- + an inline custom-element host (`<repro-region>`, default `display:inline` like `<ogygia-region>`) — **clean**
- + microtask-resolved `await` (mirrors a SEEDED remote, not a timer) — **clean**

So ogygia's hydration envelope (`[`/`]` comments + Wrapper→App + inline custom-element host) does NOT
reflow. Combined with the deploy check that `docNav`/`docsPageSnippets` do NOT re-fetch on hydrate
(the seed works — only `liveTick` streams), the bounce is NOT the envelope and NOT a remote re-fetch
pending-flash.

### ROOT-CAUSE MECHANISM (verified on the prod deploy)

Captured the sidebar region's DOM at the exact frame its flow height hits 75px:

```
sidebar <ogygia-region> (display:inline) child:  <div class="" pos=static h=75>
```

The `side-root` div's **`class` attribute is transiently `""`** during hydration. Its `position: fixed`
comes from the `.side-root` scoped class, so with the class emptied it falls back to `static` → in-flow
→ 75px tall → shoves the `min-height:100dvh; align-items:center` hero down → the h1 bounce. When the
class is restored (`side-root …`) it's `fixed` again → 0 flow → hero back. That's the ok→broke→ok.

### What still does NOT reproduce it here

This repro now renders an async-data `{#each}` list inside a `position:fixed` root **with a `class:`
directive** (`class:panel--open`), hydrated through the envelope + inline host — and the `class`
attribute is set ONCE and **never emptied** (watched via MutationObserver, independent of CSS timing).
`NestedProvider` is `<Component {...props}/>` + a context call — same as the Wrapper here, not the axis.

So the class-clear is **prod-build specific** (real Vercel + real network; local prod preview and this
dev repro don't show it). Next step to close it out: build THIS repro in prod mode (client + SSR
bundles, blocking CSS) and hydrate an async component whose fixed root uses a `class:` directive — if
the class empties there, it's Svelte's prod async-hydrate re-creating the element (class set from
empty), which is either a Svelte fix or an ogygia workaround (e.g. don't gate `position:fixed` on a
`class:`-managed class, or hold the class stable across the async-boundary hydrate).

---

# Control: Svelte async hydration does NOT flash in isolation

This started as a suspected Svelte bug — an async component (top-level `await`) appearing to have its
SSR'd `class` cleared during hydration (an unstyled flash). **It turned out Svelte is not at fault.**

This project reproduces the exact island-runtime hydration pattern with plain Svelte and shows the
class is **preserved**:

- SSR renders the async component directly (`render(App)`, awaited for the async path).
- The client hydrates a **wrapper** that renders the component (`hydrate(Wrapper, { component: App })`),
  into a target wrapped in `<!--[-->`…`<!--]-->` hydration-envelope comments — mirroring how the runtime
  hydrates islands into a custom-element host.

## Versions

- `svelte` 5.56.8 · `vite` 6.3.6 · `@sveltejs/vite-plugin-svelte` 5.1.1

## Run

```
npm install
npm run dev            # http://localhost:5199, DevTools console open
```

## Result

```
[repro] before hydrate  class = "box s-XsEmFtvddWTw"
# …and NO "class changed to ''" — the class is never cleared.
```

Variations tried, all of which preserve the class:
- `await Promise.resolve(...)` (one microtask)
- `await new Promise(r => setTimeout(r, 50))` (a real task delay)
- hydrating through the wrapper + `[`…`]` envelope (the island pattern)

## Conclusion

The real-world flash is **not** Svelte async hydration. In the failing app the async component also
calls a **SvelteKit remote function** (`query`) during hydration; removing that call (passing the data
in as a prop) removes the flash. The next place to look is the remote-query-during-hydration path, not
Svelte. Kept here as a control that rules Svelte out.
