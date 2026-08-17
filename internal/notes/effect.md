# `import.meta.og.effect()` — client side-effects that actually run on inert pages

Status: **REJECTED — do not build** (2026-08-17, same day as the design). Kept as archaeology so
the idea isn't re-litigated from scratch. The design process itself produced the verdict: every
good decision shrank the primitive (returns → gone; schedule → gone; args → gone), until what
remained was *syntax sugar over a capability islands already provide*. The final straws:

1. **It violates the framework's own legibility law.** This note rejects v3 auto-lift because "you
   can glance at a template and know what ships JS" — then proposes the one alive thing with no
   template marker. A boot island keeps aliveness visible in markup, where everything alive lives.
2. **The capture law was the tell.** Captures existed to replace what props already do, and the
   store-init case showed them erroring on the very pattern people would reach for. A component
   takes props; the mechanism already exists and everyone knows it.
3. **The price/prize ratio.** Extraction, capture analysis, mutated-set errors, HMR of generated
   modules, source maps into lifted code — paid to delete one small `.svelte` file and one tag.

**What ships instead (cheap, no macro):**

- The dev warning (step 6 below) — always the highest-value piece: top-level `onMount`/`$effect`
  in an inert route component warns "this never runs on the client here; put it in a component
  imported `with { wake }`."
- A named, blessed docs pattern: the **boot island** — a headless component holding the `$effect`,
  imported `with { wake: 'load' }` (add `keep` for layout-persistent lifecycle), values as props.
  Recipe linked from client-islands and constraints.
- One teaching bullet: module stores usually need no boot at all — top-level module code runs when
  the first island imports it; a boot island is only for effects that must run on island-less pages.

Everything below is the rejected design, preserved with its name history (`client()` → `wake()` →
`effect()`) because the collapses along the way — returns are wrong, schedules are body code,
captures want to be props — are the durable lessons.

---

Original header: Status: DESIGN ONLY (2026-08-17). Prompted by the docs-consistency audit: the
constraints page tells people "if you reach for `onMount`, you actually want an island," and the
honest fix today is a hand-rolled headless island. This note designs the library primitive that
replaces that workaround.

## Name history (design archaeology — each rejection reshaped the design)

1. **`client()`** — rejected: at the time the scope also ran on the server (an SSR snapshot pass fed
   its return value into the template), so a name implying "no server run" lied.
2. **`wake()`** — right for that design ("SSR, then come alive" is exactly what islands do), killed
   by the next decision:
3. **Returns are gone** (the collapse, below) → nothing needs the SSR pass → there is no "SSR,
   then" left for `wake` to describe. What remains is precisely Svelte's effect contract, so
   **`effect()`** inherits the correct intuitions for free: client-only, teardown via return, no
   value produced.

Spelling: **`import.meta.og.effect(...)`, a macro — not a package export.** The compiler rewrites
this call; the macro spelling is what tells users up front that special rules apply, so nobody
treats it as a normal function and overbends it (aliasing it, wrapping it, calling it conditionally).

## The collapse: no return value

First drafts let the scope return state for the template (`const view = …(() => ({ get count() … }))`).
That single feature was the source of every hard problem in the design:

- an SSR execution pass just to produce a static snapshot for the template;
- dev-warning machinery to explain why static reads never update;
- a "v2" live-handle design (same-realm registry, handle transport into islands, wake-ordering);
- a rejected-but-tempting "v3" subtree auto-lift.

The realization: **returning state made it a state primitive, and it was never one. It is a
side-effect primitive.** State belongs where it already lives — at the top level of a `.svelte.ts`
module, or inside an island. Drop the return and all four problems vanish *as categories*:

- No server execution at all. The body is client-only, like every effect.
- Nothing to read in static markup, so nothing to warn about.
- Cross-island sharing needs no new machinery — see "Sharing state" below; the idiom works today.
- Auto-lift has nothing to lift.

**Enforced mechanically:** using the call's result (`const x = import.meta.og.effect(…)`, passing
it, awaiting it) is a **build error** — "effect() returns nothing; state belongs in a module or an
island." The compiler sees the callsite anyway; the contract costs one check.

## The primitive

```svelte
<!-- +page.svelte — csr=false, and this still runs in the browser -->
<script>
  import.meta.og.effect(() => {
    const t = init_telemetry();
    const off = listen(window, 'scroll', t.track);
    return () => { off(); t.stop(); };   // teardown, exactly like $effect
  });
</script>
```

Signature: **`import.meta.og.effect(fn)` — one argument, like `bake`.** No options bag.

- **No schedule option.** The effect runs when the runtime boots. Anything later is the body's own
  business — `requestIdleCallback` for telemetry, `scheduler.postTask`, whatever fits. Timing is
  ordinary code, not framework surface. (The scope renders no UI, so element-bound schedules —
  `'visible'`, `'interaction'`, media — never applied anyway.)
- **No args option.** Values from the page are just *referenced* — the capture law below routes
  them. An explicit args array would be a second, worse spelling of the same thing, and it could
  never cover everything a body references anyway (router hooks like `beforeNavigate`, imported
  helpers — those are imports, carried whole).

```ts
import.meta.og.effect(() => {
  requestIdleCallback(() => init_telemetry(data.dsn));   // data.dsn: captured, see below
});
```

## Semantics: `$effect.root`, lifecycle-managed

`fn` runs **once per lifecycle** (not re-run by reads — it is init-shaped, like `onMount`), on the
client only, **inside an active effect context** — so `$state` and inner `$effect(...)` calls work
normally inside it for the tracked parts. Teardown = the returned function, plus cleanup of any
inner effects. An `async fn` is legal but cannot return a teardown (it returns a promise); manage
cleanup via inner effects or explicitly.

This is the user's original instinct — "Svelte has `$effect.root` for this kind of stuff" — with
the root's manual lifetime replaced by a framework-managed one (the portability law, below).

## The rewrite law (three contexts, one construct)

No runtime export exists; like every `import.meta.og.*` construct the call is rewritten at build
and never reaches runtime. Unrewritten (plugin missing), it throws on its first line — loud, never
a silent server-only no-op.

| context | the rewrite |
| --- | --- |
| Kit page, csr=true | `$effect(() => untrack(fn))` inline — client-only, once, teardown honored, effect context provided by the component itself |
| inside any ogygia island | same inline rewrite — the island is hydrated |
| ogygia route component (csr=false — inert) | **no local call at all** (nothing runs server-side); the compiler extracts `fn` into a generated headless island minted at the callsite, whose entire script is that same `$effect` line, with captures arriving as island props |

`untrack` gives init-shaped once-semantics (stray reactive reads in `fn` must not re-run a
telemetry boot); inner `$effect`s opt the tracked parts back in deliberately.

**Call-position rule:** top-level statement of a component `<script>` — ordinary namespace law
(same strictness as `wire`). Needed for the inline rewrite (component init context) and the lift
(statically findable callsite) alike.

## Sharing state — the idiom that replaced "v2"

The old design needed a registry + handle transport so islands could read the scope's state. The
return-less design needs a documentation paragraph:

```ts
// src/lib/presence.svelte.ts — state at MODULE top level (the user's law: "vars must be top level")
export const presence = $state({ online: 0 });
```

```ts
// +layout.svelte — the brain: pump the module from a socket
import.meta.og.effect(async () => {
  const { presence } = await import('$lib/presence.svelte');
  const ws = connect();
  ws.onmessage = (m) => { presence.online = m.count; };
});
```

Any island that imports `presence` reads it **live**: all islands share one JS realm and one Svelte
runtime chunk, so module-level `$state` is a single reactivity graph across every island on the
page. No handle, no ordering problem, no serialization — the module system is the registry.

(The effect imports the module dynamically only to keep the lift's import-graph story simple in the
example; a static import in `fn`'s carried imports works the same.)

## The portability law (lifecycle)

**`effect(fn)` gives `fn` the lifecycle the host component would have in a Kit csr=true app.**

- `+page.svelte` callsite → teardown + re-run per navigation (Kit remounts pages).
- `+layout.svelte` callsite → runs once, persists while navigation stays inside that layout's
  segment; leaving the segment tears it down (Kit layout lifecycle).

Mechanism for the layout case: the minted island carries the existing keep/persist mark
(`data-ogygia-keep` + stable per-callsite id). The router's persist pairing already relocates kept
nodes across a body swap when both documents contain the pair — precisely "navigating within the
segment." Leave the segment → no pair → node drops → teardown runs. Kit's semantics fall out of
shipped machinery.

## The capture law

The extraction problem is one the codebase already solves twice — `og-bake.ts` (free-vars +
dead-import removal) and **region snippets** ("captures are serializable"). `effect` adopts the
snippet capture rules wholesale:

- **Imports are carried.** `fn` may use anything it imports — router hooks (`beforeNavigate`),
  helper modules, a `.svelte.ts` state module. The compiler carries the import graph into the
  generated island module. Client bundle cost = what `fn` imports, nothing else.
- **Component-scope reads are captured.** A free variable referencing component scope (`data.dsn`)
  is detected by the free-vars pass and routed as a devalue-serialized island prop under the
  island-props law (same serializability rule, same cap). Non-serializable capture → build error
  naming the variable.
- **Captures are read-only snapshots.** They're serialized at render, so a write through the
  closure would hit a dead copy in the lifted case while hitting the live variable in the inline
  case — a silent world-divergence. The free-vars pass already computes the mutated set; a write
  to a captured variable is a build error. (Reads are snapshot-vs-live in theory too, but the body
  runs once and inert route components have no client execution to change values under it —
  documented as "captures are render-time snapshots," and done.)

One namespace-grammar note survives the args removal: every other construct takes only
build-readable inputs; `fn` is build-read (written in place, like `bake`'s) but its captures are
**runtime values**. Sound because the build never reads them — it only routes them. Rule of thumb:
*what the build must understand is literal; what merely flows to runtime may be an expression.*

### The store-init case (the capture error is the teacher, not the obstacle)

The obvious worry: "I just want to wrap my store init in this" —

```svelte
<script>
  const cart = new CartStore();               // runs on the SERVER only (inert component)
  import.meta.og.effect(() => cart.hydrate()); // build error: non-serializable capture
</script>
```

— a store can't serialize, so is the headline use case dead? No: **this pattern was already dead.**
On a csr=false page the component-scope `cart` never exists in the browser; there is nothing for
the effect to initialize. The capture error doesn't forbid a working spelling — it names a
silently-meaningless one, exactly like the `onMount` guardrail. Both working spellings involve no
capture at all:

```ts
// 1. module top level ("vars must be top level") — an IMPORT, carried whole, readable live by islands
export const cart = new CartStore();          // cart.svelte.ts
import.meta.og.effect(() => cart.hydrate());  // route file

// 2. born inside the effect — local, no capture
import.meta.og.effect(() => { const cart = new CartStore(); register(cart); });
```

The asymmetry this error papers over deliberately: on a Kit csr=true page the component-scope
version *would* work (live closure). The portability law forbids it in both worlds so one file
can't be correct in Kit and silently dead in ogygia. The error message must therefore teach, not
scold: *"`cart` is created in component scope, which never runs client-side here — create it inside
the effect, or move it to module scope."*

## Why it lives on `import.meta.og.*`

An early draft argued the namespace ships baked serializable values, so behavior didn't belong.
That distinction was already false: `wire`'s `encode`/`decode` run at runtime on every
serialization; a `loader.*` call ships a live source object whose methods run at request time. The
namespace's real contract is:

> **The build must see this call, written in place. You don't alias it, wrap it, or pass it
> around. Misuse is a build error, never a silent no-op.**

Exactly `effect`'s contract — and the spelling enforces it socially: users already read
`import.meta.og.*` as "the build talking; don't overbend."

## Where it sits in the family

| primitive | runs | reactivity | returns |
| --- | --- | --- | --- |
| `script(fn, ...args)` | before first paint, once per document | none | nothing (emits a `<script>` string to place) |
| `import.meta.og.effect(fn)` | client-only, at hydration, per the portability law | effect context (inner `$state`/`$effect` legal) | **nothing — build error to use** |
| island (`with { wake }`) | SSR + at hydration | full component | — |
| `import.meta.og.wire` | codec runs at (de)serialize time | — | codec key on a class |
| `import.meta.og.bake(fn)` | at build, never shipped | none | inlined constant |

`script` vs `effect` is the clean before/after pair: `script` = pre-paint, no imports, no
reactivity, once per document. `effect` = post-hydration, own imports, effect context, per the
portability law.

## Compiler shape (sketch)

1. Detect `import.meta.og.effect()` in the existing construct pipeline (`og-extract`/`og-parse` —
   the same AST-precise recognition every construct uses) at top level of a route component
   (`+page.svelte`, `+layout.svelte`, `+error.svelte`).
2. Build error if the call's value is used (assigned, passed, awaited, chained).
3. Extract `fn` + its import graph into a generated module (free-vars + bake extraction
   discipline; captures per the capture law — serializable reads become props, writes and
   non-serializables are build errors).
4. Inert route: remove the statement from the route component entirely; mint the headless island —
   a rendered `<ogygia-region>` with no visual box, waking at runtime boot, keep-mark iff layout
   callsite, captures as props. Hydrated contexts: inline `$effect(() => untrack(fn))`.
5. Non-route components: v1 does **not** lift (a shared component can't know at compile time
   whether its consumer hydrates); the inline rewrite still makes it correct inside islands and on
   Kit pages. Dev census warning covers the hole: an `effect()` whose element never woke on a
   csr=false page warns with the component name.
6. The `onMount` guardrail rides along: dev-warn on top-level `onMount`/`$effect` in an inert route
   component — "this never runs on the client here; did you mean `import.meta.og.effect()`?"

## Open questions

- Multiple `effect()` calls per file: one island each vs merged into one generated module. Lean:
  merge — with no per-call schedule left, separate elements buy nothing.
- `+error.svelte`: page or layout lifecycle? (Kit treats it page-like; follow Kit.)
- Async `fn` teardown story: document-only, or accept `AbortSignal` as a second param to `fn` for
  cancellation symmetry? Lean: document-only in v1.

## Do / don't (docs voice, for when this ships)

- **Do** put init, telemetry, global listeners, and subscription pumps in `effect()` — the things
  you used to reach for `onMount` for.
- **Do** keep shared state at the top level of a `.svelte.ts` module; islands read it live for
  free. The effect pumps state; it never owns it.
- **Don't** try to read anything back from `effect()` — it returns nothing, by design and by build
  error. If a value feeds the template, it is server data (`load`, collections) or island state.
- **Don't** wrap page UI in islands just to observe an effect's work — if a subtree must react, it
  was an island already.
