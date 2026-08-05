# Contributing to ogygia

## Naming conventions (the naming gate)

These rules are enforced by **review**. The linter (**oxlint**, wired into `check`) does not yet
ship a `naming-convention` rule (verified against oxlint 1.77 — the rule does not exist in its
`typescript` plugin), so naming can't be automated there; the table below is the contract. The
`no-explicit-any` half of the old "zero-any" gate **is** now an oxlint rule (`typescript/
no-explicit-any`, error) for `.ts`; the `scripts/no-any.mjs` script still covers `.svelte`
(oxlint doesn't parse Svelte).

| kind | case | examples |
| ---- | ---- | -------- |
| **Public API** — package exports, option keys, hook names | `camelCase` | `ogygia`, `ogygiaHandle`, `OgygiaRouter`, option keys `spa` / `visible` / `presets` / `margin` / `hydrate` / `defer` / `endpoint` / `viewTransitions` |
| **Classes & Svelte components** | `PascalCase` | `Island`, `ServerIsland`, `NestedProvider`, `LakePlaceholder`, `LakeBoundary`, `LakeRegion`, `OgygiaBoundary`, `OgygiaRouter`, the runtime custom-element class |
| **Internals** — locals, module-private functions, non-exported helpers, `#` private fields | `snake_case` | `run_transform`, `merge_head`, `#on_visible`, `hashed_runtime_url`, `collect_pattern_names` |
| **Module-level constants** | `SCREAMING_SNAKE_CASE` | `ISLAND_DIR`, `RUNTIME_ENTRY`, `APP_SHIMS` |

### Deliberate exceptions (do not "fix" these to snake_case)

- **Kit-contract identifiers.** The `$app/*` shims and the `kit-remote/*` stubs must export the
  exact names Kit's own modules import (`page`, `navigating`, `base`, `assets`, `app_dir`,
  `query_map`, `set_nearest_error_page`, …). Match Kit, not our style.
- **The `$app/navigation` surface** re-exported from `runtime/router.ts` and `ogygia/app`
  (`goto`, `invalidateAll`, `beforeNavigate`, …) mirrors Kit's public API and stays `camelCase`.
- **Cross-module object-property contracts.** Property keys shared between a producer and a
  consumer stay identical on both sides rather than following the local-variable rule — the
  transform `ctx` object (`virtualPathFor`, `devUrlFor`, `visibleMargin`, `libDir`, `pathModule`,
  `readFile`), the island descriptor objects (`virtualPath`, `hostPath`), and the standalone
  build options (`clientDir`, `makePlugin`, `runtimeFileName`).
- **DOM / Web API option keys** passed as object literals keep their platform spelling
  (`rootMargin` for `IntersectionObserver`).
- **Generated output identifiers** (the wrapper component names the transform injects, e.g.
  `OgygiaIsland__Wrapper` / `OgygiaServerIsland__Wrapper`) are `PascalCase` because Svelte requires
  component tags to be uppercase.

## Verifying a change

```bash
pnpm run check          # no-any (svelte) + build lib + [tsc + vitest + oxlint] (lib) + svelte-check (playground) + tsc (verify) — must be 0/0
pnpm --filter playground build
ORIGIN=http://localhost:3060 PORT=3060 node playground/build/index.js &   # prod
# then run every suite in verify/*.ts against the running server (and against `pnpm --filter playground dev`)
```

The library's `check` runs `tsc --noEmit && vitest run && oxlint` (the transform unit suite + the
`no-explicit-any` lint gate). `svelte-check` remains the template/markup guard for the playground.

> **Formatter note (empirical, oxfmt 0.62):** oxfmt was evaluated as the repo formatter and **not
> adopted** — the released version does not format `.svelte` (a `.svelte` file passes through
> unchanged), its default `.ts` style diverges from the repo's single-quote/tab style (there is no
> prior Prettier config to preserve), and its default mode writes in place. A `.ts`-only reformat
> would be a large, `.svelte`-inconsistent churn for no functional gain. Revisit once oxfmt gains
> first-class Svelte support.

See `verify/README.md` for the full suite list.
