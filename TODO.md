# ogygia — status & remaining work

## Round 5 (this round) — landed & verified
- **Remote reuse — Plan A, DONE (no patch).** `__sveltekit/remote` now points at Kit's REAL
  `remote-functions/index.js`; the two router-coupled modules it imports (`client.js`,
  `state.svelte.js`) + `$app/paths/internal/client` are scope-aliased (only for importers under
  `/remote-functions/`, so a csr=true page's real Kit client is untouched) to **34 lines of stubs**
  (`app` from the universal `transport`; `goto`/`invalidateAll` → our SPA router; `page.url`;
  `base`/`app_dir`). Kit's own query/command/query.live/cache/proxy/sse/**form** run in islands with
  NO router graph. The 222-line hand-rolled wire client is **deleted** (222 → 34). `verify/remote.ts`
  (incl. custom `transport` `Temperature`) passes.
- **Remote `form()` inside islands — DONE.** `guestbook.remote.ts` (form + valibot) + `GuestbookForm`
  island: enhanced submit (no reload), schema field issues, pending, result, and no-JS post to the
  remote endpoint. Checks added to `verify/forms.ts`.
- **Type coverage — DONE (tsc-clean).** `@types/node`; ambient decls for virtual modules + `$app/*`;
  `SkIsland` fields declared; typed plugin options. `verify/tsconfig.json` + `global.d.ts`. Scripts:
  library `check` (tsc --noEmit), root `check` (lib tsc + playground svelte-check + verify tsc) — all
  **0 errors / 0 warnings** (playground svelte-check 369 files).

## Remaining / next (documented precisely; ordered)
1. **ZERO-`any` mandate — NOT done.** Reaching tsc-clean used ~23 `any`/`as any` in library src +
   4 in verify, all in inherently-dynamic code. Replace each with precise types:
   - `vite/free-vars.ts` (4): estree node casts → import `estree` `Node`/`Function` types.
   - `runtime/router.ts` (~7): `mergeHead(newHead)` → `HTMLHeadElement`; loop nodes → `Element`;
     `history.state` is already `any` in lib.dom (leave) ; `fn:any` hooks → a `Navigation` cb type;
     `goto(url,opts)` → `string|URL` + `{replaceState?:boolean}`.
   - `vite/transform.ts` (2): svelte AST node → `{ start:number; end:number }` interface.
   - `hooks.ts` (2): `render(mod.default)` → a `Component` type; `{event,resolve}` → `Handle`.
   - `shims/app-state.ts` (1): `snap()` → a `PageSnapshot` interface.
   - `runtime/index.ts`/`NestedProvider.svelte`: component/props → Svelte `Component`/`Snippet`.
   - Add an enforcement step (eslint `no-explicit-any` if eslint is added, else a grep gate in root
     `check`). NOTE: the grep gate will fail until the above are done.
2. **DOM element rename → single `<o-region>`** (supersedes o-hydratable/o-deferable): one custom
   element, axes as attributes (`entry`, `hydrate="…"` absent=not hydrated, `defer` + `endpoint`).
   Touch: SSR emission (Island.svelte/ServerIsland.svelte), runtime class + nearest-boundary rule
   (any o-region is a boundary; "hydrated" = has `hydrate` attr), ALL suite selectors, README/DESIGN.
3. **Directory rename** `packages/sk-islands` → `packages/ogygia` (git mv) + all path refs
   (workspace globs, playground dep, tsconfigs, verify require-shims, docs, import.meta.url logic).
4. **Flicker fix** (hydration mismatch hunt + seed SSR-resolved query results into Kit's now-reused
   client query cache so hard reloads show zero visible change). Also the nested-route CSS-in-head
   sanity check.
5. **Kit-driven runtime hashing** (standalone already hashed): rewrite server output's baked URL after
   the client build, or a pre-build source-content hash both bundles compute.
6. **/plain full-nav links** (tiny). **Lakes** (`hydrate:'false'`) per DESIGN.md.



## Round 4 (this round) — landed & verified
- **Scripts feature REMOVED entirely** (user decision). No `<script bundle>` extraction, no
  chunk emission, no SPA-swap re-execution / `data-rerun` / module-URL dedupe, no ambient attr
  type, no `scripts` suite. The library now touches ONLY region imports (`hydrate`/`defer`/`preset`)
  and nothing else. Inline `<script>` runs on full loads only; after a client-side swap, inserted
  scripts do not run (standard browser behaviour) — use an island. Our runtime `<head>` module
  script persists across swaps (verified). README/DESIGN updated.
- **Remote client reuses Kit's wire codec + transport** (see the section below).
- **Runtime chunk hashing** — PARTIAL, blocked by Kit's build order:
  - **Standalone mode (all-csr=false): DONE** — the runtime ships content-hashed
    (`_app/immutable/ogygia-runtime.<hash>.js`, verified in SSR HTML). The standalone client build
    was moved to `buildStart` of the SSR build (island discovery is prescan-based), so the hashed
    name is known before the server bundle inlines it via the virtual runtime-url module.
  - **Kit-driven mode (a csr=true route exists): NOT hashed — genuinely blocked.** Kit builds the
    SERVER bundle FIRST, then the client (kit `exports/vite/index.js`: "first, build server nodes …"
    then "create client build"). The server inlines the runtime `<script src>` at server-build time
    and cannot learn a hash the *later* client build produces; a forward handoff is impossible. The
    only fixes are (a) the client build (2nd) rewrites the already-emitted server chunk + prerendered
    HTML to swap a placeholder → hashed name, or (b) a deterministic source-content hash both builds
    compute identically. Both are follow-ups; today Kit-driven keeps the stable fixed name.
  - `<script bundle>` chunk emission was deleted, so `sk-scripts/<hash>.js` is gone from the audit.

## Verified suites (10): fetch-checks, browser, dashboard, remote, mixed, server-islands, nested,
## presets, forms, prerender — all pass prod + dev; svelte-check 0/0.

## Remaining / next (documented precisely)
- **Full remote-primitive reuse + `form()`** — see "Remote client" section. Current reuse is the
  wire codec only; the reactive cache + primitives remain ours because Kit's are coupled to
  `client.js` (the router). Next: scoped alias of `client.js`/`state.svelte.js` → lightweight shims
  (Plan A) or a minimal pinned Kit patch (Plan B) to seed `app`, then reuse query/command/form.
- **Hydration flicker on hard reload** (reported) — two candidates to fix: (1) hunt hydration
  mismatches (Date/locale text server-vs-client — pin demo formatting to ISO/fixed TZ); (2) async/
  remote islands flashing pending because they refetch at hydration — seed each island's SSR-resolved
  query results into the client cache so hydration adopts DOM with no refetch/flash. The proper fix
  for (2) depends on reusing Kit's client query cache (i.e. the full-primitive reuse above).
- **CSS-in-head audit for nested routes** (standalone mode) — verify island CSS links are in the
  initial `<head>` on deep routes; quick sanity check flagged, not yet a dedicated suite.
- **Lakes** (`hydrate: 'false'`) — approved as the next round (DESIGN.md). Currently a clean build
  error. Placeholder-swap in the island client module, `<sk-lake>` DOM lift/restore, `restore` option.

---


## Landed & verified this round (build + dev, real browser, adapter-node prod)

- **Server islands** (`import X from '…' with { defer: 'true' }`). Fallback snippet SSRs into the
  page; component is NOT rendered at page-SSR. `<sk-island data-strategy="server" data-endpoint>`
  + a `<link rel="preload" as="fetch">` hint. Runtime fetches `<base>/_islands` (same-origin,
  cookies) and swaps innerHTML; fallback stays on failure (dev-logged). HMAC-signed devalue props
  (key from `OGYGIA_SECRET` or a per-build key baked into the SERVER bundle only). Endpoint =
  `ogygiaHandle()` from `ogygia/hooks` (composes with `sequence()`), resolving island modules via a
  server manifest (dev: ssrLoadModule of the fake `.svelte` path; build: generated import map).
  Remote functions + `await` run during the deferred render; island CSS reaches the page via the
  import graph; zero component JS ships on csr=false. Verified tamper→403, unknown id→404, cookie
  personalization, preload reuse (one server render, no double-fetch), SPA-swap single-fetch,
  all-csr=false standalone. Suite: `verify/server-islands.ts`.
- **tsdown library build**: `packages/sk-islands` builds to `./dist` (`.js` + `.d.ts`, `unbundle`,
  `platform: neutral`). Svelte-pipeline files ship as source (copied): `*.svelte`,
  `shims/remote-client.svelte.js` (runes), `ambient.d.ts`. `package.json` exports point at `dist`;
  the playground consumes the built `dist`. Scripts: `build`, `prepublishOnly`; root `build:lib`.
- **TypeScript everywhere**: all library + playground `.js` → `.ts`, configs → `.ts`, verify
  `*.mjs` → `*.ts` (Node 26 type-stripping). `svelte.config.js` stays `.js`. `svelte-check` script
  added; **0 errors / 0 warnings**. Ambient `ogygia/ambient` types the `<script bundle>` attr.
- **Region-model syntax** (DESIGN.md): single import attribute, exactly one of `hydrate` /
  `defer` / `preset`. Media query is the `hydrate` value. No option keys inline — tuning lives in
  plugin config `ogygia({ visible: { margin }, presets })`. Presets are tolerant (unknown keys
  error; inapplicable-known keys ignored). Precise build errors (unknown preset, inline option,
  preset+key, `defer`+`hydrate` roadmap, `hydrate:'false'` lakes roadmap). Suite: `verify/presets.ts`.
- **`<script island>` → `<script bundle>`** rename (behavior identical). Ambient type + playground + docs.
- **`createContext`** (Svelte 5.40+) for the nested-region flag (typed, no key constants).
- **Nested regions**: inner island degrades to a plain component, hydrates once with its parent
  (client seeding via a `NestedProvider`; SSR via context). Dev warning names the inner region.
  Runtime guard implements the nearest-boundary rule (skip only when the nearest ancestor region
  hydrates — a `defer` hole/lake does not count). Server island nested in a client island degrades
  to inline. Suite: `verify/nested.ts`.
- **Prerender**: `verify/prerender.ts` — a `prerender = true` page with a normal island + a
  personalized server-island hole. Static file on disk, counter hydrates from it, hole fills at
  runtime. Server-island preload hint is skipped while prerendering (else the crawler hits the
  dynamic endpoint).
- **Classic forms**: `verify/forms.ts` — plain `<form method="POST">` actions on csr=false, no-JS
  (303 post-redirect-get; fail→re-render) and JS (native submit, router does NOT intercept —
  proven by `__marker` changing). In-memory guestbook demo.

Suites (11): fetch-checks, browser, dashboard, remote, scripts, mixed, server-islands, nested,
presets, forms, prerender — all pass prod + dev. `svelte-check`: 0/0.

## Remote client — wire-protocol reuse (DONE this round)

The island `__sveltekit/remote` replacement (`src/shims/remote-client.svelte.js`) no longer
reimplements the wire protocol. It now **deep-imports Kit's OWN codec** — `runtime/shared.js`
(`stringify_remote_arg`, `stringify_command_arg`, `create_remote_key`) — via an absolute-path
alias from the vite plugin (`virtual:ogygia/kit-wire`, bypassing Kit's exports map, **no patch**),
and derives client `decoders` from the app's universal **`transport`** hook
(`virtual:ogygia/transport`, importing `src/hooks.ts` directly). Result: custom `transport` types
and `File` args now round-trip exactly against Kit's server parser (previously only built-in
devalue types worked — caveat removed; proven by `Temperature` in `verify/remote.ts`). The hand-
rolled `b64url`/`encodeArg` are deleted. What remains ours is the thin **reactive cache**
(`QueryResource`/`LiveQueryResource`) — in Kit that lives in `client.js`, which is coupled to the
full router (see below), so it is intentionally not reused.

**Full primitive reuse (query/command/form imported from Kit) — assessed, deferred.** Kit's
`remote-functions/*` import `{ app, goto, query_map, live_query_map, query_responses,
prerender_responses, set_nearest_error_page, invalidateAll }` from `client.js` and
`{ page, navigating }` from `state.svelte.js`. `app` is only set inside `start()` (full client
boot) — there is no small setter. To reuse the primitives we'd alias `client.js` → a lightweight
shim (providing `app` built from transport, the maps, and our router's `goto`/`invalidateAll`) and
`state.svelte.js` → a page/navigating shim, SCOPED to remote-functions importers so Kit's real
client on csr=true pages isn't broken. That pulls in `cache.svelte.js`/`proxy.js`/`instance.svelte.js`/
`sse.js`/`form-utils.js` (and gives `form()` for free). It's feasible but a large, mixed-mode-risky
change to a passing system; Plan B (a one-line exports-map/setter patch to Kit) is the fallback if
the scoped alias proves unworkable. Next step.

## NOT done — next up (documented, with notes)

### Remote `form()` inside islands (REQUIRED, not started)
Blocked on the "full primitive reuse" above (Kit's `form.svelte.js` + `form-utils.js` field-proxy/
issue-flattening depend on `client.js`). Once the scoped `client.js`/`state` shim lands, `form()`
comes with it. Until then it throws `unsupported('form')`; use classic form actions.
The client `__sveltekit/remote` replacement (`src/shims/remote-client.svelte.js`) implements
`query`/`command`/`query.live`; `form` is still `unsupported('form')`. Kit's client form lives in
`node_modules/@sveltejs/kit/src/runtime/client/remote-functions/form.svelte.js` and leans on
`form-utils.js` (`create_field_proxy`, `deep_set`, `normalize_issue`, `flatten_issues`) plus the
booted client cache (`get_cache`) and `apply_action`. To ship inside islands we must port the
field-proxy + issue-flattening surface (`.as()`, `.value()`, `.issues()`, `.allIssues()`, `pending`,
`result`) and wire the spreadable `{ action, method, onsubmit }` to POST Kit's remote-form endpoint
(multipart) and apply the returned `{ result, issues }` without a full reload. The **no-JS** path
should post natively to the remote-form endpoint (real Kit server re-renders) — verify Kit 2.70's
server handling under csr=false. Single-flight `.updates()` likely needs Kit's booted client and may
be the documented gap. Acceptance: island remote form, no-JS + JS-enhanced, issues + result +
devalue field values.

### Lakes (`hydrate: 'false'`) — approved as the NEXT round
Per DESIGN.md + coordinator: swap the lake import for a placeholder in the island's CLIENT module
(no lake JS in any client chunk — add a build-output assertion), SSR renders it inline, wrap it in
`<sk-lake>`, lift/re-insert its DOM around parent hydration, `restore: 'cache' | 'empty'`
(`ogygia({ lakes })`). Island-inside-a-lake self-hydrates (already falls out of the nearest-
boundary rule). Currently `hydrate: 'false'` is a clean build error ("roadmap — see DESIGN.md").

## Standing caveats (unchanged)
- Remote `command` (POST) needs a correct `ORIGIN` in production (Kit CSRF; dev skips it).
- `$app/*` shims reach island-boundary imports; deep imports in shared components: use props or
  `ogygia/app`. `page.data` is snapshotted per island.
- Standalone (all-csr=false) build assumes `kit.appDir === '_app'` and uses `vitePreprocess()`.
- Server islands are a `csr = false` feature (documented); nested server islands degrade to inline.
