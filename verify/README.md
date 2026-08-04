# Verification

```bash
# 1. Build the library, then the playground (adapter-node)
pnpm --filter ogygia build
pnpm --filter playground build

# 2. Start the production server. ORIGIN is required for remote `command` (POST) + form CSRF.
ORIGIN=http://localhost:3051 PORT=3051 node playground/build/index.js &

# 3. Run the checks (from repo root; Node 26 runs .ts directly)
node verify/fetch-checks.ts    http://localhost:3051   # SSR: island HTML, no Kit bootstrap
node verify/browser.ts         http://localhost:3051   # hydration, strategies, devalue, SPA
node verify/dashboard.ts       http://localhost:3051   # page shim, island goto, client table, chart
node verify/remote.ts          http://localhost:3051   # client query+args+refresh, command, live
node verify/mixed.ts           http://localhost:3051   # csr=true coexistence + opt-in router
node verify/server-islands.ts  http://localhost:3051   # defer:'true' fallback/endpoint/HMAC/cookie/CSS
node verify/nested.ts          http://localhost:3051   # island-in-island single hydration + dev warn
node verify/presets.ts                                 # transform-level: region syntax + presets + errors
node verify/forms.ts           http://localhost:3051   # classic form actions (no-JS + JS)
node verify/prerender.ts       http://localhost:3051   # prerendered page + server-island hole
node verify/flicker.ts         http://localhost:3051   # SSR-resolved query seeding: zero-flash hydration
node verify/lakes.ts           http://localhost:3051   # lakes: frozen region, no client JS, island-in-lake, restore
node verify/mutation-guards.ts http://localhost:3051   # captured-var mutation: build errors + DEV proxy warns / prod-silence
node verify/defer-timing.ts    http://localhost:3051   # server-island fetch timing: load/idle/visible/media + preload-only-for-load
```

`mutation-guards.ts` runs its build-time checks (transform errors for writing to a captured var)
with no server; pass a base URL to ALSO check the runtime DEV proxy. It is mode-aware: against a
PROD build it asserts prod-silence (no warnings); against `vite dev` it asserts the once-per-path
warnings for an object property, a Map mutator, and a Set mutator.

`flicker.ts` is mode-aware: against a PROD build it asserts the full zero-visible-change contract
(no re-fetch for SSR-resolved queries, live still connects, `.refresh()` still re-fetches); against
`vite dev` it asserts the graceful fallback (no seed → islands re-fetch, content stays correct).
See the dev caveat below.

All server-backed suites also pass against the dev server (`pnpm --filter playground dev`), e.g.
`node verify/server-islands.ts http://localhost:5173`. Dev needs no `ORIGIN` (Kit skips CSRF in dev).
`presets.ts` runs the built transform directly (no server needed).

### Dev caveat — remote-query seeding is production-only

The flicker fix reads Kit's INTERNAL per-request store (`@sveltejs/kit/internal/server`) to capture
SSR-resolved query responses. That store is a module singleton. In a production bundle everything is
one module graph, so our `ogygiaHandle` sees the live store and seeds the client (zero flash). Under
`vite dev`, Kit's server runtime resolves that module to a DIFFERENT instance than the externalized
library does (Vite SSR + pnpm boundary) — reachable only via `$app/server`, which does not expose the
store — so `try_get_request_store()` reads an empty store. We degrade gracefully: no seed is emitted,
islands re-fetch on hydration exactly as before (correct content, a brief re-render). No Kit patch can
be applied here, so dev keeps the pre-fix behavior. `verify/flicker.ts` asserts each mode accordingly.

Playwright chromium is required for the browser suites (`pnpm exec playwright install chromium`).
