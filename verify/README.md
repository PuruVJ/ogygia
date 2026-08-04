# Verification

```bash
# 1. Build the library, then the playground (adapter-node)
pnpm --filter sk-islands build
pnpm --filter playground build

# 2. Start the production server. ORIGIN is required for remote `command` (POST) + form CSRF.
ORIGIN=http://localhost:3051 PORT=3051 node playground/build/index.js &

# 3. Run the checks (from repo root; Node 26 runs .ts directly)
node verify/fetch-checks.ts    http://localhost:3051   # SSR: island HTML, no Kit bootstrap
node verify/browser.ts         http://localhost:3051   # hydration, strategies, devalue, SPA
node verify/dashboard.ts       http://localhost:3051   # page shim, island goto, client table, chart
node verify/remote.ts          http://localhost:3051   # client query+args+refresh, command, live
node verify/scripts.ts         http://localhost:3051   # inline / data-rerun / bundled <script bundle>
node verify/mixed.ts           http://localhost:3051   # csr=true coexistence + opt-in router
node verify/server-islands.ts  http://localhost:3051   # defer:'true' fallback/endpoint/HMAC/cookie/CSS
node verify/nested.ts          http://localhost:3051   # island-in-island single hydration + dev warn
node verify/presets.ts                                 # transform-level: region syntax + presets + errors
node verify/forms.ts           http://localhost:3051   # classic form actions (no-JS + JS)
node verify/prerender.ts       http://localhost:3051   # prerendered page + server-island hole
```

All server-backed suites also pass against the dev server (`pnpm --filter playground dev`), e.g.
`node verify/server-islands.ts http://localhost:5173`. Dev needs no `ORIGIN` (Kit skips CSRF in dev).
`presets.ts` runs the built transform directly (no server needed).

Playwright chromium is required for the browser suites (`pnpm exec playwright install chromium`).
