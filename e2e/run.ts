#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — full library e2e suite.
//
// Builds the library + playground, serves the production build, and runs EVERY
// verify check against it (islands, server islands, lakes, partials-in-playground,
// portable bindings, nesting, remotes, forms, router, prefetch, presets, defer,
// rate-limit, dedup, …). One command, green-or-red, run it every time.
//
//   node e2e/run.ts                 # build fresh, serve, run all checks
//   node e2e/run.ts --no-build      # reuse the existing playground build
//   node e2e/run.ts --only=lakes,browser
//   PORT=3060 node e2e/run.ts
//
// Exit code is non-zero if any check fails, so it drops straight into CI.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 3051);
const BASE = `http://localhost:${PORT}`;
const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;

// [file, needsServer, note]. needsServer=false → build-output / transform-level check (no base URL).
const CHECKS: Array<[file: string, needsServer: boolean, note: string]> = [
	['fetch-checks.ts', true, 'SSR island HTML, no Kit bootstrap'],
	['browser.ts', true, 'hydration, load/idle/visible/media, devalue, SPA'],
	['console.ts', true, 'zero hydration_mismatch across pages (incl. /lakes)'],
	['hydrate-in-place.ts', true, 'islands adopt SSR root (no discard+recreate / class-less flash)'],
	['lakes.ts', true, 'frozen region, no client JS, island-in-lake, restore, remount cache/swr'],
	['nested.ts', true, 'island-in-island single hydration + dev warn'],
	['server-islands.ts', true, "defer fallback/endpoint/HMAC/cookie/CSS"],
	['frame-dedupe.ts', true, 'frame store: identical twins share ONE endpoint fetch'],
	['frame-batch.ts', true, 'batch frame stream: one response, a frame per call (nav OOO)'],
	['frame-single-flight.ts', true, 'single-flight: command returns the re-rendered region, no extra fetch'],
	['frame-nav-batch.ts', true, 'single-flight nav: SPA nav pulls all load regions in ONE batch, no waterfall'],
	['frame-ooo.ts', true, 'out-of-order streaming: staggered regions flush fast-first, not declaration order'],
	['defer-timing.ts', true, 'server-island fetch timing load/idle/visible/media'],
	['remote.ts', true, 'client query+args+refresh, command, live'],
	['live-partial.ts', true, 'query.live partials: swap no-fetch, keep-alive, static morph'],
	['flicker.ts', true, 'SSR-resolved query seeding: zero-flash hydration'],
	['forms.ts', true, 'classic form actions (no-JS + JS)'],
	['mutation-guards.ts', true, 'captured-var mutation: build errors + DEV/prod runtime'],
	['prerender.ts', true, 'prerendered page + server-island hole'],
	['prefetch.ts', true, 'router preload hover/click/eager/viewport/tap/off'],
	['region-rate.ts', true, 'forged-MAC flood → all 403, budget intact'],
	['router-race.ts', true, 'overlapping SPA navigations / stale-swap guards'],
	['dashboard.ts', true, 'page shim, island goto, client table, chart'],
	['page-state.ts', true, 'page.url/params/route/status/data/form/error/state in islands'],
	['split-brain.ts', true, 'REGRESSION: $app/stores-first island shared with a csr=true page (og-region identity)'],
	['mixed.ts', true, 'csr=true coexistence + opt-in router'],
	['portable-bindings.ts', true, 'static/dynamic/list bindings + shared-entry dedupe'],
	['transportables.ts', true, 'static [ogygia.wire] codec: cross-island live object, no leak, alias-proof'],
	['continuity.ts', true, 'named wire codec: session-lifetime cart survives SPA nav, merge, tab-isolated'],
	['context.ts', true, 'createContext + <Context>: subtree provide, DOM-bridged, live across roots'],
	['island-children.ts', true, 'host children/snippets cross into a hydrate island (synth entry)'],
	['portable-snippet.ts', true, 'a snippet forwarded THROUGH a plain shell into an island crosses + comes alive'],
	['snippet-islands.ts', true, 'islands in a {#snippet} to a plain shell: marks survive + top-level await SSRs'],
	['interaction.ts', true, "wake:'interaction' — cold until used, click replay, typing survives"],
	['presets.ts', false, 'transform-level: region syntax + presets + errors'],
	['dedup.ts', false, 'same-component-two-strategies → ONE client chunk']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const banner = (s) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);

function sh(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', ...opts }).status === 0;
}

async function waitForServer(timeoutMs = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(BASE + '/', { redirect: 'manual' });
			if (r.status > 0) return true;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	return false;
}

// ── 1. build ────────────────────────────────────────────────────────────────
if (!noBuild) {
	banner('▸ Building library');
	// The tsdown config's svelte plugin copies `.svelte` sources into dist — no separate copy step.
	if (!sh('node', ['node_modules/tsdown/dist/run.mjs'], { cwd: join(repo, 'packages/ogygia') })) process.exit(1);
	// ── prerender-secret warning, BOTH directions ─────────────────────────────
	// Prerendered pages mint ~forever capabilities. With NO stable OGYGIA_SECRET the build must
	// warn (once — ServerIsland + swr-lake mints share the guard); WITH one it must stay silent.
	// The playground keeps a real secret in .env, so the warn path is exercised by a throwaway
	// build with that secret hidden, then the real (kept) build asserts silence.
	const playground = join(repo, 'apps/playground');
	const env_file = join(playground, '.env');
	const env_bak = join(playground, '.env.ogygia-warncheck-bak');
	const WARN_RE = /per-build random key[\s\S]*?OGYGIA_SECRET/;
	const build_captured = (env: NodeJS.ProcessEnv) => {
		const res = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
			cwd: playground,
			encoding: 'utf-8',
			env
		});
		return { ok: res.status === 0, out: (res.stdout ?? '') + (res.stderr ?? '') };
	};
	// Self-heal a crashed earlier run before touching anything.
	if (existsSync(env_bak) && !existsSync(env_file)) renameSync(env_bak, env_file);

	banner('▸ Building playground (warn-path probe: secret hidden)');
	{
		const child_env = { ...process.env };
		delete child_env.OGYGIA_SECRET;
		let probe: { ok: boolean; out: string };
		const had_env_file = existsSync(env_file);
		if (had_env_file) renameSync(env_file, env_bak);
		try {
			probe = build_captured(child_env);
		} finally {
			if (had_env_file) renameSync(env_bak, env_file);
		}
		if (!probe.ok) {
			process.stdout.write(probe.out);
			console.error('FAIL  warn-path probe build failed');
			process.exit(1);
		}
		if (WARN_RE.test(probe.out)) {
			console.log('PASS  no stable secret → build warns about prerendered capabilities');
		} else {
			process.stdout.write(probe.out);
			console.error('FAIL  no stable secret, but the prerender-capability warning is missing');
			process.exit(1);
		}
	}

	banner('▸ Building playground (production)');
	{
		const real = build_captured(process.env);
		process.stdout.write(real.out);
		if (!real.ok) process.exit(1);
		if (WARN_RE.test(real.out)) {
			console.error('FAIL  stable OGYGIA_SECRET present, but the build still warned');
			process.exit(1);
		}
		console.log('PASS  stable secret → build is silent about prerendered capabilities');
	}
}

// ── 2. serve ──────────────────────────────────────────────────────────────
banner(`▸ Serving playground at ${BASE}`);
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
	cwd: join(repo, 'apps/playground'),
	env: { ...process.env, ORIGIN: BASE }, // ORIGIN needed for remote command (POST) + form CSRF
	stdio: 'ignore'
});
const killServer = () => {
	try {
		server.kill('SIGTERM');
	} catch {
		/* noop */
	}
};
process.on('exit', killServer);
process.on('SIGINT', () => {
	killServer();
	process.exit(130);
});

if (!(await waitForServer())) {
	console.error('\x1b[31m✗ preview server never came up\x1b[0m');
	killServer();
	process.exit(1);
}

// ── 3. run every check ────────────────────────────────────────────────────
const toRun = CHECKS.filter(([file]) => !only || only.some((o) => file.startsWith(o)));
const results = [];
for (const [file, needsServer, note] of toRun) {
	banner(`▸ ${file}  — ${note}`);
	const started = Date.now();
	const args = needsServer ? [`e2e/${file}`, BASE] : [`e2e/${file}`];
	const ok = sh('node', args);
	results.push({ file, ok, ms: Date.now() - started });
}

// ── 4. summary ────────────────────────────────────────────────────────────
killServer();
banner('════════════════════  SUMMARY  ════════════════════');
for (const { file, ok, ms } of results) {
	const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
	console.log(`  ${tag}  ${file.padEnd(24)} ${(ms / 1000).toFixed(1)}s`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length) {
	console.log(`\x1b[31m✗ ${failed.length}/${results.length} check(s) FAILED: ${failed.map((f) => f.file).join(', ')}\x1b[0m`);
	process.exit(1);
}
console.log(`\x1b[32m✓ all ${results.length} checks passed\x1b[0m`);
process.exit(0);
