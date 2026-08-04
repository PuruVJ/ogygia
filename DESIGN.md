# The Region Model — unified design for islands, lakes, and holes

## One sentence

A page is a tree of **regions**; every boundary may set exactly two properties —
**when its HTML arrives** (`render`) and **whether its JS wakes up** (`hydrate`) —
and each property is decided by the **nearest boundary above you**.

## The two axes

Every region boundary answers two independent questions:

| axis      | values                                            | question                     |
| --------- | ------------------------------------------------- | ---------------------------- |
| `render`  | `page` (default) \| `defer`                       | When does this HTML arrive?  |
| `hydrate` | `false` (default) \| `load` \| `idle` \| `visible` \| `'(media query)'` | Does this subtree's JS wake, and when? |

The page shell is simply the root region: `render: page`, `hydrate: false`.
Everything else is an override at some boundary.

## The one rule (nearest boundary wins)

Hydration state is **inherited down the DOM tree**. A boundary overrides it for
its subtree. Therefore:

- An island in the static shell hydrates itself (nearest state above it: dead).
- An island inside a hydrated island does **not** self-hydrate — its parent's
  hydration already runs it as a plain component. One hydration, ever.
- A **lake** (`hydrate: false`) inside an island turns its subtree dead again:
  the SSR DOM is preserved untouched, and the lake component's JS never ships.
- An island **inside a lake** self-hydrates again — the lake made its subtree
  dead, so the runtime treats the inner island exactly like one in the shell.

So interactivity can alternate all the way down —
`shell → island → lake → island → …` — with no special cases. This is the same
alternation React Server Components allow between server and client components,
expressed as plain HTML regions.

The runtime implements the rule mechanically: a region element self-hydrates iff
the nearest region boundary above it is **not hydrated** (none, or a lake).
Custom elements make this navigation-proof: any swap that inserts regions
(SPA router, server-island fill) re-evaluates the same rule on connect.

## What the old names mean now

| render | hydrate            | you'd call it              | status      |
| ------ | ------------------ | -------------------------- | ----------- |
| `page` | `false`            | plain component / the shell | shipped     |
| `page` | `load`/`idle`/`visible`/media | **client island**          | shipped     |
| `page` | `false` *inside a hydrated region* | **lake**   | planned     |
| `defer`| `false`            | **server island**          | shipped     |
| `defer`| any strategy       | deferred client island     | roadmap     |

"Island" and "lake" survive as vocabulary, not as separate mechanisms.

## Composition semantics (all derived from the rule, none ad-hoc)

- **Island in shell**: hydrates per its strategy.
- **Island in island**: plain component; dev warning that the inner strategy is
  ignored (it rides the parent's hydration).
- **Lake in island**: subtree stays SSR DOM; its component code is excluded from
  the island's client module (import swapped for a placeholder; the runtime
  lifts the DOM out before hydration and restores it after). Frozen content:
  props changes and events inside are inert by contract.
- **Island in lake**: self-hydrates. Its own module was already code-split and
  its props were serialized during page SSR, so it is fully self-describing.
- **Lake in shell / lake in lake**: no-op (already dead). Allowed, pointless.
- **Server island (defer) in shell**: fallback SSRs; hole fetches its HTML and
  swaps on connect (preload-hinted).
- **Server island in island / in lake**: the hole is inert DOM to its parent;
  it fills itself on connect. (Roadmap once lakes land; until then: degrades to
  a plain component with a dev warning.)

## Boundaries are declared at the import

One declaration site (the import attribute), one vocabulary across all of it.
Serialization contract is unchanged everywhere: markup crosses as code, values
cross as devalue, functions never cross.

## Out of scope of the model (orthogonal features)

- `<script bundle>` / inline scripts — imperative escape hatch, not a region.
- `<ClientRouter />` — swaps regions wholesale; the rule re-applies on connect.
- Remote functions — data plane; regions are the rendering plane.
