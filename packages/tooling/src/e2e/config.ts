// One package's e2e suite: its specs (e2e/*.spec.ts beside the config) against its own fixture app.
// Each package's playwright.config.ts is `export default suite({ … })`; the package's `e2e` script runs
// it, and turbo's `e2e` task (turbo.json) decides which packages' suites rerun.
//
// Ports: every suite owns its own (`port`, and any server a spec boots), so no two suites ever
// collide. The libraries are built by turbo before the suite starts (`e2e` depends on `^build`).
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const BUILD = fileURLToPath(new URL('./build.ts', import.meta.url));

export interface SuiteOptions {
	/** This suite's port: the served app's (its `baseURL`). Unique across the repo's suites. */
	port: number;
	/** Build this app, then serve it (`vite preview`) at `port` for the specs' `page`. */
	serve?: string;
	/** The serve command, when the plain build + preview is not enough (cwd: the `serve` app). */
	command?: string;
	/** A path the served app answers once it is up (default `/`). */
	ready?: string;
	/** Build this app before the suite and serve nothing (the specs boot their own servers). */
	build?: string;
	/** Extra env for the served app. */
	env?: Record<string, string>;
}

export function suite(opts: SuiteOptions): PlaywrightTestConfig {
	const base = `http://localhost:${opts.port}`;
	return defineConfig({
		testDir: 'e2e',
		testMatch: /.*\.spec\.ts$/,
		// fixture apps (and their node_modules) live under e2e/ too; they hold no specs
		testIgnore: ['**/node_modules/**', '**/app/**'],
		// A fixture app carries per-server state that several specs mutate (counters, guestbook, rate
		// budgets): serial workers, one at a time.
		fullyParallel: false,
		workers: 1,
		retries: 0,
		timeout: 180_000,
		expect: { timeout: 10_000 },
		reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
		use: { baseURL: base, trace: 'retain-on-failure' },
		...(opts.build ? { globalSetup: BUILD, metadata: { build: opts.build } } : {}),
		...(opts.serve
			? {
					webServer: {
						// Build THEN preview, in one process chain, so the preview loads exactly the build it
						// just produced — never a stale in-memory bundle a concurrent rebuild deleted under it.
						// (Not globalSetup: Playwright starts the webServer BEFORE globalSetup.)
						command:
							opts.command ??
							`node ${BUILD} && node node_modules/vite/bin/vite.js preview --port ${opts.port} --strictPort`,
						cwd: opts.serve,
						url: base + (opts.ready ?? '/'),
						// ORIGIN: remote commands (POST) + form CSRF
						env: { ORIGIN: base, ...opts.env },
						// never a leftover server from an earlier run: this run's build defines what is served
						reuseExistingServer: false,
						timeout: 240_000
					}
				}
			: {})
	});
}
