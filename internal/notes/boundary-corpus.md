# Boundary corpus — context & store patterns from a real production migration target

A census of a large production SvelteKit codebase (~1,900 source files) considering ogygia
adoption. Every `setContext`/`getContext` and store-creation pattern was catalogued and
anonymized into the 21 cases below. This is the ground truth the transportable seam is built
against; `packages/ogygia/test/boundary-seam.test.ts` is its executable form.

## Census shape (anonymized)

- **178** `setContext` provision points; ~186 real `getContext` reads.
- **771** store singletons minted by ONE house factory (`createStore(seed, key?)` returning
  `{subscribe, set, update, useLocalStorage, useSessionStorage}` — methods over a closure).
- **~130** store `derived`s (45 multi-source); 23 declared inside components off the framework
  `page` store.
- **100+** module-level store singletons in a single file (shared server-wide during SSR —
  a pre-existing cross-request hazard islands merely expose).
- Value natures at `setContext`: **~95 plain data**, **~48 inline stores** (41 of them ONE
  repeated `setContext(SYMBOL, writable(v))` + `readonly(getContext(...))` idiom), **6** house-
  factory stores, **5** bare callbacks, **~7** mixed objects (store + methods), 0 rune-state.
- Consumer behavior: ~90% of reads are read-only data; the minority destructure methods or
  `$`-subscribe.

## The one insight

Split by "does this context actually cross an island boundary?" and the problem collapses:
plain data (~95) crosses free; the scariest values (DOM-ref stores, modal callbacks, a
store+methods+DOM mega-object) are provided and consumed inside ONE component subtree — one
island — so they never serialize. What genuinely spans islands is mostly stores, and 41 of
those are a single structural pattern. **Granularity first, serialization second.**

## The 21 cases

Legend: gate = does it reach the wire · shape = transport kind · outcome.

### Group 1 — plain data (crosses free)
- **C1 flag/string** `setContext('dir', 'rtl')`, boolean flags → devalue, byte-identical.
- **C2 server object/array** page blocks, resolved links, layout-props maps → devalue.
- **C3 DOM-derived string** `{firstComponentId: el.id}` — computed FROM the DOM but crosses
  as a string → fine.
- **C4 big nested metadata** one block object provided under several keys → devalue +
  identity dedupe (same object must not fork).

### Group 2 — same-island (must NOT serialize; native context)
- **C5 DOM-ref stores + callbacks** a scroll container's `Readable<HTMLElement>` refs + arrow
  callbacks; provider and consumers share one subtree.
- **C6 store holding a DOM node** carousel/gallery stores with an element field.
- **C7 modal close callback** `setContext('closeModal', fn)` read by children of the modal.
- *Test meaning:* if the seam ever serializes these, the island boundary was drawn wrong.

### Group 3 — stores spanning islands (auto-wire: seed + reunify)
- **C8 the symbol-keyed writable family (41×)** `setContext(KEY, writable(v))` + consumer
  `readonly(hasContext(KEY) ? getContext(KEY) : writable(default))` → auto-wire, reunify by
  id; one mechanism clears all 41.
- **C9 house-factory store** `createStore(seed)` with grafted methods (incl. browser-only
  `useLocalStorage`) → factory registered by tag; decode = `factory(seed)`, methods rebuilt,
  browser-only bits stay `BROWSER`-guarded.
- **C10 derived crossing** component-level `derived(page, …)` and store deriveds → the VALUE
  can seed but the DERIVATION is lost; must warn loudly (re-derive client-side or wire the
  sources), never freeze silently.

### Group 4 — mixed objects spanning islands
- **C11 tabs context** `{store, id, onChange, variant}` destructured by children → usually
  same-island; if crossing: store auto-wires, `onChange` needs hoisting (`og.$`).
- **C12 the mega-object** store + 5 async methods doing network calls + mutating a live web
  component → same-island in practice; the case that proves granularity-first. If forced to
  cross: network methods → remote functions; DOM mutation → impossible, refuse.
- **C13 store-getter with grafted methods** getter returns `{...readonly(store), add(), remove()}`
  → store auto-wires; methods come from the getter MODULE on the client, never the wire.

### Group 5 — genuinely can't cross (locate + refuse)
- **C14 DOM node in a crossing value** → refuse with context key + dot-path + "provide it
  from an island".
- **C15 cyclic CLASS instance** (linked list with next/prev + prototype methods) → refuse
  naming the class, point at `import.meta.og.wire`. (Cyclic PLAIN objects are devalue-native
  and fine.)
- **C16 secret in context** `setContext('apiToken', token)` — serializes fine, LEAKS into
  island HTML → policy refusal by key/path sniff; no shape check can catch it.
- **C17 side-effecting store creation** stores that read `window`/`localStorage` and attach
  listeners AT CREATION → decode must reunify-not-recreate or listeners double-register and
  stale SSR seeds clobber `localStorage`.
- **C18 exotic values** `writable(new Map())` fine (devalue-native); a live timer handle in a
  store value → warn (meaningless across the wire).

### Group 6 — hazards islands expose (pre-existing)
- **C19 module-level singletons** shared server-wide across requests → reunify must key
  per-request; flag the singleton pattern itself as an SSR-safety audit.
- **C20 duplicate key, conditional identity** the same key set at layout AND page level with
  different lifecycles → reunification ids must be scoped (per boundary), not global.
- **C21 large payloads** full config objects in context → not wrong, but islands ship context
  into HTML; dev size warning + identity dedupe.

## Mechanism map

| Cases | Mechanism | Status |
|---|---|---|
| C1–C4 | devalue (+ id dedupe) | shipped (dedupe: store ids are per-instance WeakMap — done for stores) |
| C5–C7 | granularity MARKER: `setContext(key, value, { islands: false })` | **shipped** — inference from `getContext` call-sites was REJECTED (import aliasing / wrapper modules make any scan under-inclusive; a missing island key is the fatal direction, so ogygia never guesses — default bridges, the marker opts out) |
| C8, C9, C13 | store auto-wire (`OgygiaW`) + factory registry + reunify | **shipped** (`store-transport.ts`) |
| C10 | classifier `warn` on derived-like | **shipped** (`boundary.ts`) |
| C11, C12, D-callbacks | `import.meta.og.$` hoist / remote fns | runtime half **shipped** (`fn-transport.ts`: fn kind + `fn_handle` + `__register_fn`; captures rebind, store captures reunite); compiler hoist pass remains |
| C14, C15 | classifier `refuse` with path | **shipped** |
| C16 | secret-key sniff (policy) | **shipped** (sniff); allow/deny config later |
| C17 | reunify-not-recreate | shipped for the client (live map); `clientInit` codec option later |
| C19, C20 | scoped ids, per-request isolation | server `remember:false` shipped; singleton audit is app-side |
| C21 | size warning | not built |

## Traps to keep honored (learned from the census)

1. Reunify ids must be identity-based (WeakMap per instance), never path-based — one object
   under two keys must stay one instance (C4/C20).
2. Secrets ride plain values; only policy catches them (C16).
3. `decode` may run in the browser — a factory that side-effects at creation must not re-fire
   per island (C17): the live-map memo is what prevents it.
4. `derived` has no seed; silent freezing is the one auto-wire behavior that would corrupt
   apps quietly (C10) — always warn.
5. Module singletons were already a cross-request hazard before islands (C19) — surface,
   don't hide.
