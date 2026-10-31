// Build a fixture app for its e2e suite: `vite build` in the app's directory. The libraries it
// depends on are already built — the `e2e` turbo task depends on their `build` (turbo.json). Skipped
// under E2E_NO_BUILD=1 (reuse the app's existing build).
//
//   node <tooling>/src/e2e/build.ts          # the app in the current directory (a webServer command)
//   globalSetup: <tooling>/src/e2e/build.ts  # the app in `metadata.build` (a suite with no server)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

/** Build the app in `dir`; throws (with the build's output already printed) when it fails. */
export function build_app(dir: string): void {
	if (process.env.E2E_NO_BUILD) {
		console.log(`▸ E2E_NO_BUILD=1 — reusing the existing build of ${dir}`);
		return;
	}
	console.log(`▸ Building ${dir}`);
	const res = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
		cwd: dir,
		stdio: 'inherit'
	});
	if (res.status !== 0) throw new Error(`e2e build failed: ${dir}`);
}

/** Playwright `globalSetup`: build the app the config names in `metadata.build`. */
export default function global_build(config: FullConfig): void {
	const dir = config.metadata.build;
	if (typeof dir !== 'string')
		throw new Error('e2e build: the config names no app (metadata.build)');
	build_app(dir);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		build_app(process.cwd());
	} catch (e) {
		console.error(`\n✗ ${(e as Error).message}`);
		process.exit(1);
	}
}
