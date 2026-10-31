// Build the palaestra for its e2e run — the FIRST half of the Playwright `webServer` command
// (`node e2e/e2e-build.ts && vite preview …`, cwd: the palaestra), so the preview process loads
// exactly the build this produced. The libraries are already built: turbo's `e2e` task depends on
// their `build` (run the suite with `pnpm turbo run e2e --filter=palaestra`).
//
// Why not globalSetup? Playwright starts `webServer` BEFORE `globalSetup`. When the build lived in
// globalSetup, the preview booted on the PREVIOUS build (loading its server bundle into memory), then
// globalSetup rebuilt under it — and because chunk hashes are non-deterministic across builds, the
// still-running preview emitted `<script>` URLs for chunks the rebuild had just deleted. The next
// request for one 404'd, and vite preview turns a missing-file ReadStream error into an unhandled
// 'error' event that crashes the whole process — so the first test failed and every later test got
// ECONNREFUSED. Building HERE, before `vite preview` starts, removes the rebuild-under-a-live-server
// race entirely: one build, then one preview over it, no concurrent second build anywhere.
//
// Skip the build with E2E_NO_BUILD=1 (reuse an existing build) — then this is a no-op and preview
// serves whatever is already on disk. The prerender-secret warn-path probe: prerendered pages mint
// ~forever capabilities, so with NO stable OGYGIA_SECRET the build must warn (once), and WITH one it
// must stay silent. A failed probe exits non-zero, which fails the webServer command and thus the
// whole run before any spec touches it.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const WARN_RE = /per-build random key[\s\S]*?OGYGIA_SECRET/;

/** Fail the whole run: print why, then a non-zero exit so `&& vite preview` never starts. */
function fail(message: string, extra?: string): never {
	if (extra) process.stdout.write(extra.endsWith('\n') ? extra : extra + '\n');
	console.error(`\n✗ e2e build: ${message}`);
	process.exit(1);
}

function build_palaestra(env: NodeJS.ProcessEnv) {
	const res = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
		cwd: app,
		encoding: 'utf-8',
		env
	});
	return { ok: res.status === 0, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

if (process.env.E2E_NO_BUILD) {
	console.log('▸ E2E_NO_BUILD=1 — reusing the existing palaestra build');
	process.exit(0);
}

const env_file = join(app, '.env');
const env_bak = join(app, '.env.ogygia-warncheck-bak');
// Self-heal a crashed earlier run before touching anything.
if (existsSync(env_bak) && !existsSync(env_file)) renameSync(env_bak, env_file);

console.log('▸ Building palaestra (warn-path probe: secret hidden)');
{
	const child_env = { ...process.env };
	delete child_env.OGYGIA_SECRET;
	const had_env_file = existsSync(env_file);
	if (had_env_file) renameSync(env_file, env_bak);
	let probe;
	try {
		probe = build_palaestra(child_env);
	} finally {
		if (had_env_file) renameSync(env_bak, env_file);
	}
	if (!probe.ok) fail('warn-path probe build failed', probe.out);
	if (!WARN_RE.test(probe.out))
		fail('no stable secret, but the prerender-capability warning is missing', probe.out);
	console.log('PASS  no stable secret → build warns about prerendered capabilities');
}

console.log('▸ Building palaestra (production — this is what the preview serves)');
{
	const real = build_palaestra(process.env);
	process.stdout.write(real.out);
	if (!real.ok) fail('palaestra build failed');
	if (WARN_RE.test(real.out)) fail('stable OGYGIA_SECRET present, but the build still warned');
	console.log('PASS  stable secret → build is silent about prerendered capabilities');
}

console.log('▸ e2e build complete — starting preview\n');
