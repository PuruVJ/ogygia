# Runtime redesign

Status: **IMPLEMENTED.** One typed `slots.ts` registry replaced `host.ts` (stringly service
locator) + `spa-bridge.ts` + the router's own setters; each `features/<name>.ts` wrapper was merged
into its impl (`export function install()`); `host.ts`, `spa-bridge.ts`, and `features/` are deleted
(−10 runtime files). Core's per-document lifecycle is a `spaLifecycle` slot core fills in `boot()`,
so router modules never import core's Svelte-component graph (kept `router`/`persist` unit-testable);
`persist` declares `live` as a build dep instead of importing `LiveHost`. Verified identical:
**28 e2e checks + 218 unit tests + 0 type errors + no-any**. Runtime bundle: playground **8.6 → 7.8
KB gzip (−9 %)**, docs unchanged. Everything below is the original proposal, kept as the record.

---

## What is good and stays

The split itself is the smart part and it works. `vite/runtime-entry.ts` reads build-time marks
(does this app use lakes? forms? router? streaming? …) and generates a per-app entry that imports
**only** the features in use, then boots them. Result today:

| app | runtime chunk (gzip) | why |
| --- | --- | --- |
| docs | ~5.9 KB | fewer features |
| playground | ~8.6 KB | continuity + streaming + everything |

`core.ts` never statically imports a feature impl, so unused features tree-shake away. **Keep all of
this** — the codegen, the marks, the core-is-feature-agnostic rule.

## The mess: three mechanisms doing one job

A feature needs to hand some functions to `core` (and to `router`). Today there are **three
different ways** it does that, chosen inconsistently:

| mechanism | who registers this way | shape |
| --- | --- | --- |
| **`spa-bridge.ts`** | lakes, forms, persist | typed module-global `let x_ops` + `set_x_ops()`, no-op defaults |
| **`host.ts`** | wire, remote-seeds, speculate, interaction, stream, morph, live, persist | **stringly-typed** `api.provide('name', …)` / `api.service('name')` / `api.arm('name')` |
| **`router.ts` setters** | router lifecycle | a *third* set of `set_after_body_swap/connected/soft_invalidate()` |

On top of that:

- **`persist` registers through two of them** — `set_persist_ops(...)` (spa-bridge) *and*
  `api.provide('persist', …)` + `api.provide('liveHost', …)` (host).
- **`live` and `persist` both provide `liveHost`** — a silent last-writer-wins duplicate.
- **`api.provide('kitBootstrap', …)` is dead** — nobody reads it (features import
  `document_has_kit_bootstrap` from `kit-boot.js` directly).
- **`spaLifecycle` is provided by core then consumed by router** to re-inject core's *own* exported
  functions (`prepare_spa_document` / `finish_spa_document` / `apply_soft_invalidate_doc`) back into
  router via its setters — a round trip that exists only because of the indirection.
- **Every feature is two files**: a `features/<name>.ts` wrapper whose whole job is to forward a
  sibling impl (`lakes.ts`, `morph.ts`, `form-continuity.ts`, …) into one of the registries.
  11 features → 22 files.
- **`host.ts` service names are strings**, so there is no compile-time link between what a feature
  provides and what `core` reads. `api.service<StreamService>('stream')` is a cast, not a check.

Everything core consumes today, for reference (all via the stringly host except the ops):

```
core reads:  wire · remoteSeeds · speculate · interaction(arm) · stream · liveHost · morph
             · persist.is_persist_preserving        (host, stringly)
             · lake_ops.*                             (spa-bridge, typed)
core provides (for features): kitBootstrap(dead) · persist(default) · spaLifecycle(round-trip)
router reads: spaLifecycle → its own set_after_body_* setters
```

## Proposed design: one typed registry

Keep the **good** pattern (spa-bridge: a typed slot with a no-op default that a feature fills), and
make it the **only** pattern. Delete `host.ts` and the router setters.

### 1. One `slots` object, fully typed

Rename/replace `spa-bridge.ts` with `slots.ts` holding **every** feature contribution as a typed,
optional field with a safe default:

```ts
// runtime/slots.ts — the single seam between core and optional features
export type Slots = {
  lakes: LakeOps;            // no-op default (freeze = inert SSR)
  persist: PersistOps;       // no-op default
  forms: FormOps;            // { enabled: false } default
  interaction: ArmFn | null; // hydrate scheduler; null = never wakes
  morph: ((from: Element, to: Element) => void) | null;
  live: LiveHostComponent | null;
  stream: StreamSlots | null;
  wire: WireOps | null;
  remoteSeeds: RemoteSeedOps | null;
  speculate: { reinstall(): void } | null;
};

export const slots: Slots = {
  lakes: NOOP_LAKE_OPS, persist: NOOP_PERSIST_OPS, forms: { enabled: false, /* … */ },
  interaction: null, morph: null, live: null, stream: null, wire: null,
  remoteSeeds: null, speculate: null,
};
```

Core and router read it directly and typed — optional chaining replaces the stringly lookups:

```ts
// before (core.ts)
get_api().service<SpeculateService>('speculate')?.reinstall();
const arm = get_api().arm('interaction'); if (!arm) { … }
lake_ops.lift(this);

// after
slots.speculate?.reinstall();
if (!slots.interaction) { … }
slots.lakes.lift(this);
```

### 2. One file per feature, each exporting `install()`

Collapse each `features/<name>.ts` wrapper into its impl. One module per feature that owns its code
**and** registers it:

```ts
// runtime/lakes.ts  (was runtime/lakes.ts + runtime/features/lakes.ts)
export function install() {
  slots.lakes = { on_frozen_connect, wait_for_boundary, lift, restore, settle_in, /* … */ };
}
// …all the impl functions live here too
```

`boot()` takes the install fns and calls them in a fixed order (the order already encoded in
`FEATURE_ORDER`, which matters: stream starts before the CE upgrades, morph before live):

```ts
export function boot(installers: Array<() => void> = []) {
  for (const install of installers) install();
  if (slots.stream?.active) slots.stream.start();
  defineOgygiaRegion();
}
```

The generated entry (`runtime-entry.ts`) and `full.ts` import the feature modules and pass their
`install` fns — same as today, minus the `features/` layer:

```ts
import { boot } from './core.js';
import * as lakes from './lakes.js';
import * as router from './router.js';
boot([lakes.install, router.install /* … only the selected features */]);
```

### 3. Core → feature: just import core

`spaLifecycle`, `kitBootstrap`, and the router `set_after_body_*` setters all go away. Core already
**exports** `prepare_spa_document` / `finish_spa_document` / `apply_soft_invalidate_doc`; `router.ts`
imports them directly (core is always in the bundle, so a feature importing core is free and does not
break tree-shaking). `document_has_kit_bootstrap` is already imported straight from `kit-boot.js`.

## File-by-file change

| file | change |
| --- | --- |
| `host.ts` | **delete** (service locator gone) |
| `spa-bridge.ts` | **becomes** `slots.ts` — every feature slot, typed, defaults |
| `features/*.ts` (11) | **delete** — merged into the impls |
| `lakes.ts`, `morph.ts`, `form-continuity.ts`, `persist.ts`, `interaction.ts`, `speculate.ts`, `stream-slots.ts`, `live-transport.ts`(wire), `remote-cache/client-stub`(remote-seeds), `LiveHost.svelte`(live) | each gains `export function install()` that fills its slot |
| `router.ts` | drop `set_after_body_*`; import lifecycle from core; add `install()` filling nothing but starting the router |
| `core.ts` | replace `get_api()/service/arm/provide` with `slots.*`; drop the `api`/`HostApi` singleton; `boot(installers)` |
| `full.ts` / `index.ts` | import impls instead of `features/*`; pass `install` fns |
| `vite/runtime-entry.ts` | `FEATURES[id].module` points at the impl (`lakes.js` not `features/lakes.js`); emit `boot([…install])` |

Net: **−12 files** (`host.ts` + 11 wrappers), one seam, zero stringly keys.

## Tradeoffs

**Pros**
- One mechanism instead of three; every hand-off is typed and checked.
- Half the runtime files; no wrapper/impl bounce.
- Same split, same-or-smaller bundle (we delete `host.ts`'s Map machinery and the wrapper modules).
- Cross-registration, the `liveHost` dup, the dead `kitBootstrap`, and the `spaLifecycle` round-trip all disappear.

**Cons / risks**
- Large diff: touches `core.ts`, every feature, `router.ts`, `full.ts`, `index.ts`, `runtime-entry.ts`.
  Mitigated by the green net — migrate one feature at a time, run `pnpm test:e2e` (28) + unit (218) after each.
- Install **order** is load-bearing (stream→CE, morph→live). It stays explicit in `FEATURE_ORDER`;
  `boot()` preserves it.
- A single mutable `slots` object is global module state (same as `spa-bridge` today). Acceptable and
  already the norm for the browser runtime; it is the one-instance-per-tab boot singleton.

**Alternatives considered**
- *Typed generic `HostApi`* (keep the locator, add generics): still a service locator, still string
  keys at every call site. The slot object is simpler and already proven by spa-bridge. Rejected.
- *Collapse to a monolith* (no split): loses the size win — docs would jump ~5.9 → ~8.6 KB gzip.
  Rejected (you picked "keep the split").

## Decisions I need from you

1. **Name** for the single registry: `slots.ts` (my pick) / `registry.ts` / keep `spa-bridge.ts`.
2. **Install convention**: keep `export function install()` per feature (my pick), or have each
   feature `export const slot` and let `boot` assign — slightly less code, but loses per-feature
   setup logic (stream.start guard, forms/speculate config gates), so I lean `install()`.
3. Anything you want to *add* while it's open (e.g. a dev warning when a mark selected a feature the
   app never actually uses), or keep it a pure like-for-like refactor?

No code until you're happy with the shape.
