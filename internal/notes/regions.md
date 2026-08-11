# One Region — the full unification (stage 2)

> Stage 1 (surface rename `partial`→`region`) is DONE and green. This is the design for stage 2:
> collapse every wrapper into one `Region`, make every marked import mintable, delete the `partial:` key.
> Captured 2026-08-10.

## The thesis

ogygia has ONE renderable unit: the **region**. Everything else is a dial on it or a way to use it.

- **Declare**: `import C with { wake, fill }` (+ `keep`). No `partial:` key — that's the whole point.
- **Use**: *place* it (`<C />`) or *hold* it (`region(C, props)`). Same unit, two usages.
- **Realize**: `<Region of={held}>` is the mount()-like step — it reads the descriptor and emits `<ogygia-region>` as inline / island / deferred.
- Island, lake, server island, block, content body = all regions with different dial settings. The old names become nicknames.

## TARGET VOCABULARY — LOCKED 2026-08-10

Explored "collapse wake+fill into one flat `region:` key" and **rejected it**, for two verified reasons:
1. **2D, not 1D.** `wake` (when JS runs) and `fill` (when HTML arrives) are independent axes. `fill: 'load', wake: 'visible'` is TWO schedules — no single flat string encodes it without an ugly compound. Data: playground+docs have 133 wake-only, 27 fill-only, ~8 fill+wake combos (several with *different* per-axis values).
2. **Reads wrong.** `region: 'load'` puts a schedule on a noun. Schedules want a VERB (`wake: 'load'` = "wake on load"). `region` is the unit (a noun); it only takes adjectives (`region: 'raw'` = "a raw region", reads fine).

**So the locked vocabulary keeps the verbs and deletes only `partial`:**

| Key | Values | Meaning |
| --- | --- | --- |
| `wake:` | `load`·`idle`·`visible`·`interaction`·`none`·`(media)` | island (or lake at `none`). when JS runs. VERB, reads right. |
| `fill:` | `load`·`idle`·`visible`·`(media)` | HTML arrives later (server / deferred). the rare 2nd axis. VERB. |
| `region:` | `'raw'` (only value) | HELD-across-a-boundary (a registry). adjective, reads right. |
| `preset:` | name | named bundle. |
| `keep:` | name | lifetime (survives navigation; was `persist`). |

- `wake`/`fill` STAY (verbs, read well, encode the real 2D). NOT renamed to `region`.
- `region` is the UNIT (concept + `region()` + `<Region>` + `<ogygia-region>`), plus the single held-marker value `region: 'raw'`.
- **`partial` is DELETED.**

## Killing `partial` without breaking blocks/portable-bindings — the transform gets smarter

The wall (proven in the 2a attempt): a marked import used AS A VALUE could be held (descriptor) or a portable binding (wrapper) — can't infer. Resolution:

- **Direct holds → NO mark.** The transform intercepts `region(C, props)` where `C` is a plain default import: it resolves `C`, emits its descriptor, rewrites the import. Bounded (one call shape, one identifier) — not dataflow chasing. So `region(SomeImport, …)` needs zero attributes.
- **Registry holds → `region: 'raw'`.** In the block pattern the components live in a `registry` object PASSED INTO a renderer, and `region(registry[type])` runs INSIDE that renderer (usually another file). Nothing bridges that boundary — the registry file sees no `region()` call, the renderer sees no imports. So registry components must be marked `region: 'raw'`. This is the ONLY surviving job of the held marker.
- **Mixed usage** (a component both placed `<C/>` AND held `region(C)`) → the transform emits BOTH a wrapper and a descriptor for it (each tree-shaken if unused). No ambiguity because placement (`<C/>`) and the `region(C)` call are both syntactically explicit.
- `region: 'raw'` on a `.ts` registry is unambiguous already (no template → always held), same as today's `transformTsPartials`.

## The mechanism: one descriptor per marked import

Today the transform emits FOUR different artifacts:
- `wake:` → an `<Island>` wrapper at the usage site + a virtual island module.
- `fill:` → a `<ServerIsland>` wrapper + endpoint machinery.
- `wake:'none'` (lake) → `<LakeRegion>`/`<LakeBoundary>`/`<LakePlaceholder>` + lift/restore.
- `partial:` → a descriptor module (`{ __component, __module, __sign, __hydrate }`) that `region()` reads.

**Stage 2: every marked import compiles to ONE descriptor module** carrying everything:
`{ component, clientChunkUrl, sign, renderHtml, wake, fill }`. That is the "generated script module with all required info."

Two usages of the same descriptor:
- **Place** `<C props/>` → transform expands to render the descriptor (props scraped off the tag). Placement path is unchanged in behavior; it just sources from the descriptor.
- **Hold** `region(C, props)` → `C` *is* the descriptor; `region()` packages it + props into a `RegionValue`.

The signer rides the descriptor but is a tiny SSR-only re-export, invoked ONLY when the region crosses the wire (returned from a remote). Tree-shaken when a region is only ever placed. So "wake emits a binding" costs nothing unless you mint-and-send.

## region() vs <Region> (the mount analogy)

- `region(C, props)` = **hold**: package component + props + capability into a value. Cheap, no DOM.
- `<Region of={value}>` = **realize / mount**: read the descriptor's schedule, decide inline-render vs island-hydrate (`wake`) vs deferred-fetch (`fill`/wire), emit `<ogygia-region>` + the props `<script>` sidecar. THIS is the one wrapper.

## The collapse: 6 components → 1

`<Region>` switches on the descriptor + schedule and absorbs all of:
- **Island** (`wake: load|idle|visible|interaction`) → `<ogygia-region wake=…>`, hydrate on schedule.
- **ServerIsland** (`fill: …`) → `<ogygia-region render="defer" when=… endpoint=…>`, fetch HTML then optional wake.
- **Lake** (`wake: 'none'`) → `<ogygia-region wake="none">`, lift/restore, zero JS. LakeRegion/LakeBoundary/LakePlaceholder fold in as the `wake:'none'` branch.
- **Partial/held** (`region()` value) → inline (same pass), or deferred (crossed the wire).

Runtime `<ogygia-region>` (core.ts) already handles wake / defer / endpoint / freeze — it stays; only the `.svelte` wrappers collapse into `Region.svelte`.

Delete after collapse: `Island.svelte`, `ServerIsland.svelte`, `LakeRegion.svelte`, `LakeBoundary.svelte`, `LakePlaceholder.svelte` (5 components), plus the transform's separate lake/server-island/partial emission branches.

## Delete the `partial:` key (per the LOCKED vocab above)

- `import_keys.partial` gone → keys are `wake`, `fill`, `preset`, `region` (value `'raw'` only), `keep`.
- `normalize_partial_value` folds into the wake-schedule normalizer; `'static'` is retired (it was `wake: 'none'`).
- Held imports carry `region: 'raw'` (registries) or NO mark (direct `region(C)`, auto-intercepted). `transformTsPartials` handles the `.ts` held case (keyed on `region: 'raw'`).
- A used `partial:` key throws a retire-error pointing to `region: 'raw'` / `region()`.

## Build order (each a green checkpoint)

This is fundamentally ONE change (the descriptor + `<Region>` renderer must land together for the disambiguation to resolve), but sequence it so each commit builds green:

1. **Descriptor unification.** Every held import (`region: 'raw'`, or a direct `region(C)` the transform intercepts) → one descriptor module (component + chunk + signer, schedule-agnostic). Delete `partial:` key; retire-error. Update consumers: registries `with { partial }` → `with { region: 'raw' }`; direct holds drop the attribute.
2. **Transform intercepts `region(C)`.** Resolve direct-import args of `region()` calls → emit their descriptors + rewrite imports. Mixed placed+held → emit both wrapper and descriptor.
3. **Merge Island + ServerIsland → Region.** Share the region-endpoint signer + `<ogygia-region>`; one wrapper, branch on `fill`.
4. **Fold held + Lakes into Region.** `<Region of>` inline/deferred branches + the `wake:'none'` (lake) branch move in. Delete Island/ServerIsland/LakeRegion/LakeBoundary/LakePlaceholder.

Verify after each: `pnpm build`, `tsc`, `pnpm test` (215), `node verify/run.ts` (28), docs build.

## Risk notes (the intricate bits)

- Nested-island rule: a region inside an awake region hydrates with its parent (Island.svelte's `isNested`). The merged Region must preserve that.
- `interaction` wake: capture + replay machinery (runtime/interaction.ts) is wake-specific; keep intact.
- FOUC CSS: marked imports keep a CSS-only import so styles join Kit's bag (transform's `__css`). Preserve in the descriptor.
- The dedupe key (content-hash → one chunk) must stay stable so `Symbol.for` coordination + `runtime_marks` don't churn.
- `Symbol.for('ogygia.partial')` + `__ogPartial` are internal wire names — kept in stage 1; can rename to `ogygia.region`/`__ogRegion` in 2a IF swept atomically across content/transport/transform/runtime, else leave (they never surface to users).

## Why it's worth it — the complete simplification

Deletes: `partial` import key + `normalize_partial_value` + the `'static'` spelling; `Island.svelte`, `ServerIsland.svelte`, `LakeRegion.svelte`, `LakeBoundary.svelte`, `LakePlaceholder.svelte` (5 components → 1 `Region`); and the attribute on every DIRECT hold (transform-intercepted). Keeps `wake`/`fill` (verbs that read right and encode the real 2D), adds one adjective value `region: 'raw'` for the registry boundary the transform genuinely can't cross.

**The whole thing in one sentence:**

> **A region is the unit. `wake` says when its JS runs (`none` = frozen), `fill` says when its HTML arrives, `keep` how long it lives — and you either place it (`<C/>`) or hold it (`region(C)`), the transform emitting a descriptor for every hold it can see, `region: 'raw'` for the ones it can't.**

That is the final shape. `region()` is the escape hatch/substrate; `<C/>` + `wake`/`fill` are sugar over it; `region: 'raw'` is the one explicit marker left, only for cross-boundary registries.
