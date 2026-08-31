# neodrag v3 — integration feedback

From wiring `@neodrag/svelte@3.0.0-next.12` (`Draggable` + `Resizable`) into the ogygia devtools window:
a floating panel that drags by its header, resizes from all 8 edges, sits partly off-screen, and persists
its layout. Everything below is real friction hit during that integration, most-painful first.

## 1. Drag + Resize composition is undocumented and easy to get catastrophically wrong

This cost the most time. To make one node both draggable and resizable you attach both
`{...drag.attach}` and `{...resize.attach}`. What nobody tells you:

- The two capabilities **sum** their position offsets into a single shared transform.
- So `Draggable.position` and `Resizable.position` must be **different** state. My first instinct —
  the natural one — was to bind both to the same `winPos` (since the docs say resize's position is "the
  same offset space as a draggable's position"). Result: the offset was applied **twice**, and the panel
  rendered translated to `2 × winPos`, i.e. off-screen and invisible. Silent, no error, very hard to
  diagnose.
- The correct model turned out to be: `winPos` for the drag translate, a **separate** `winResizeOff` for
  the w/n-resize pin translate, and neodrag sums them. Only discovered by reasoning about *why* it went
  off-screen, then reading the wrapper source.

**Asks:**
- A first-class combined primitive or documented recipe: "make a node drag- and resize-able." Ideally a
  single `position` that both capabilities cooperate on, so there is no way to double-count.
- If they must stay separate offsets, **say so loudly** in the `Resizable.position` doc: "must be a
  *different* value than the draggable's position; the two are summed."
- A worked example in the docs of a draggable+resizable panel with persistence (this is THE common case).

## 2. Resize doesn't manage `user-select` — resizing highlights the whole panel

`Draggable` manages `userSelect`/`touchAction` during a drag (great). `Resizable` does **not** — dragging
a resize handle text-selects everything under the pointer (the entire panel). I had to add
`user-select: none` myself, toggled on `isResizing || isDragging`.

**Ask:** `Resizable` should suppress text selection during an active resize gesture, same as `Draggable`
does for drag. This is never the desired behavior.

## 3. The plain-value vs getter/setter contract for `position`/`size` is invisible

Two-way binding is detected via `Object.getOwnPropertyDescriptor(options, 'position')?.set`. So:

- `position: winPos` → initial-only, captured once (and **stale** on re-attach if the state changed).
- `get position() {…}` + `set position(p) {…}` → live, controlled, written back each move.

This is clever but completely implicit — I only understood it by reading `resize.svelte.js`. It bit me
because a conditionally-rendered window (`{#if open}`) re-attaches on each open, and a plain value showed
the *construction-time* position, not the current one.

**Asks:**
- Document the accessor-detection contract explicitly (a short table: plain value = initial, get/set =
  controlled two-way).
- Consider a less magic API — e.g. an explicit `{ value, onChange }` or a `bindable`-style helper — so the
  reactivity mode is stated, not inferred from whether a setter exists.

## 4. Resize handles are all-manual boilerplate

`resize.handle(edge)` just returns `{ [RESIZE_HANDLE_ATTR]: edge }` — a data attribute. You still hand-
author 8 handle elements and position/size/cursor each edge in CSS yourself. Every consumer will write
the same ~40 lines of `.rh-n/.rh-e/.rh-se { … cursor: nwse-resize }`.

**Asks:**
- An `edges: ResizeEdge[]` (or `handles: true`) option that auto-injects the handle elements with sane
  default hit-areas + cursors, overridable via CSS custom props or slots.
- Failing that, ship a copy-pasteable handles CSS snippet in the docs.

## 5. `bounds` padding sign is a footgun without an example

To let the panel travel **past** the viewport edge I needed `bounds: { target: 'viewport', padding: -240 }`
— negative padding *expands* the bound outward. This is the opposite of the intuitive reading and is only
mentioned as "positive values shrink inward." The very common "let it go partly off-screen but keep a
grabbable sliver" case deserves a named recipe.

**Ask:** document the negative-padding trick with the off-screen use case, or add a semantic option like
`overflow: number` / `keepVisible: number`.

## 6. `ResizeEventData.x/y` semantics unclear (cumulative vs per-gesture)

For persistence I need to know whether `e.x/e.y` in `onResizeEnd` is the cumulative resize offset or just
this gesture's delta. The doc says "the offset the gesture induced," which reads as per-gesture, but for
restoring layout I need the cumulative value. Had to guess.

**Ask:** state explicitly whether it's cumulative, and ideally expose a single `resize.position` getter
that is always the total (mirroring `resize.size`).

## 7. SSR ships uncompiled runes — needs a documented Vite recipe

`dist/*.svelte.js` contain literal `$state`/`$effect`, so any SSR path must route the package through the
Svelte transform (`ssr.noExternal: ['@neodrag/svelte']`) and dev needs
`optimizeDeps.include: ['@neodrag/svelte/resize', …]` per subpath. We already do this for the docs app; it
tripped us again for a second integration.

**Asks:**
- Put the required Vite config (noExternal + per-subpath optimizeDeps) front-and-center in the install
  docs — it's not optional for SSR frameworks (SvelteKit).
- Consider shipping a pre-compiled entry (or a `browser`/`svelte` condition that's already runes-free) so
  the package can be bundled by non-Svelte-aware tools (tsdown/rollup) — we wanted neodrag *bundled into*
  a library's dist and couldn't, because the runes need the Svelte compiler.

## What was genuinely good

- Clicks pass through a draggable wrapper to inner buttons — no pointer capture, no click suppression on a
  no-move interaction. (I braced for this and it Just Worked.)
- `handle()` / `cancel()` for restricting drag origin is clean, and reusing one `cancel()` object across
  many buttons worked.
- The attachment-spread ergonomics (`{...drag.attach}`) compose nicely with Svelte 5.
- `isDragging` / `isResizing` as reactive getters made the "suppress selection while busy" fix trivial
  (once I knew resize didn't do it itself).
- The 8-edge `RESIZE_EDGES` + typed `ResizeEdge` is nice for iterating handles.
