// ogygia e2e — Playwright test runner config.
//
// One command runs the whole suite against a built + served playground:
//   pnpm exec playwright test                 # build fresh, serve, run every spec
//   E2E_NO_BUILD=1 pnpm exec playwright test  # reuse the existing playground build
//   pnpm exec playwright test split-brain     # one spec
//
// Lifecycle: the `webServer` command BUILDS then SERVES in one shell — `e2e-build.mjs` builds the
// library + playground (with the prerender-secret warn-path probe), then `vite preview` serves that
// exact build. The build MUST live here, not in `globalSetup`: Playwright starts the webServer BEFORE
// globalSetup, so a build in globalSetup ran UNDER an already-booted preview, which had loaded the
// previous build's server bundle into memory — then emitted `<script>` URLs for chunks the rebuild
// had deleted (hashes are non-deterministic across builds), and vite preview crashes the whole
// process on the first missing-file request. Building before `vite preview` starts removes that race.
// Specs drive the server through the `page` fixture; suites that boot their OWN servers (federation
// dev servers, fixture apps, adapter emulators) do so in `beforeAll`/`afterAll` or worker fixtures in
// `e2e/fixtures/`. Shared regexes live in `e2e/fixtures/re.ts`; the `check()` idiom in
// `e2e/fixtures/index.ts`.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3051);
export const BASE = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: 'e2e',
	testMatch: /.*\.spec\.ts$/,
	// The playground carries per-server state that several suites mutate (counters, guestbook,
	// rate budgets). Serial workers keep parity with the old run.ts ordering.
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: BASE,
		trace: 'retain-on-failure'
	},
	webServer: {
		// Build THEN preview, in one process chain, so the preview loads exactly the build it just
		// produced — never a stale in-memory bundle a concurrent rebuild deleted underneath it.
		// `e2e-build.mjs` is a no-op under E2E_NO_BUILD=1 (reuse the existing build).
		command: `node ../../e2e/e2e-build.mjs && node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
		cwd: fileURLToPath(new URL('./apps/playground', import.meta.url)),
		url: BASE + '/',
		env: { ORIGIN: BASE }, // ORIGIN needed for remote command (POST) + form CSRF
		// Never reuse an existing server: this run's build defines what must be served, and a leftover
		// preview from a prior run would serve a different (stale) build. Start fresh every time.
		reuseExistingServer: false,
		// Covers the two-pass playground build (warn-probe + production) plus preview startup. With
		// E2E_NO_BUILD=1 the build is skipped and the server is ready in seconds.
		timeout: 240_000
	}
});
