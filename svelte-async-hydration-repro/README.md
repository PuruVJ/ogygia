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
