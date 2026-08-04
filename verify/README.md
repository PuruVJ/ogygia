# Verification

```bash
# 1. Build the playground (adapter-node)
pnpm --filter playground build

# 2. Start the production server. ORIGIN is required for remote `command` (POST) CSRF.
ORIGIN=http://localhost:3051 PORT=3051 node playground/build/index.js &

# 3. Run the checks (from repo root)
node verify/fetch-checks.mjs http://localhost:3051   # SSR: island HTML, no Kit bootstrap        (26)
node verify/browser.mjs      http://localhost:3051   # hydration, strategies, devalue, SPA         (22)
node verify/dashboard.mjs    http://localhost:3051   # page shim, island goto, client table, chart (17)
node verify/remote.mjs       http://localhost:3051   # client query+args+refresh, command, live     (7)
node verify/scripts.mjs      http://localhost:3051   # inline / data-rerun / bundled <script island>(11)
```

All five suites also pass against the dev server (`pnpm --filter playground dev`), e.g.
`node verify/remote.mjs http://localhost:5173`. Dev needs no `ORIGIN` (Kit skips the CSRF
check in dev).

Playwright chromium is required for the browser suites (`pnpm exec playwright install chromium`).
Total: 83 checks.
