// PAGE-CSR, the DEV leg: toggling a `csr` export must refresh the SERVER's csr_true_routes —
// `virtual:ogygia/route-csr` lives in the dev SSR module graph, and before the fix it was baked
// once and NEVER invalidated: Kit flipped immediately while ogygia's server leg kept deciding
// island-vs-inline from the stale set → `<ogygia-region>` shells on a Kit-booted page with the
// runtime withheld = dead chrome (the consumer-reported desync the docstring says can't happen).
// Self-contained: boots the playground DEV server, fetches, toggles the file, re-fetches, restores.
// Usage: node e2e/dev-csr-toggle.ts
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const page_ts = join(playground, 'src', 'routes', 'csr-chrome', 'kit', '+page.ts');
const PORT = 3079;
const base = `http://127.0.0.1:${PORT}`;
const URL_PATH = '/csr-chrome/kit/';

let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetch_html = async () => {
	try {
		const res = await fetch(base + URL_PATH, { headers: { accept: 'text/html' } });
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
};
/** Poll until the page HTML satisfies `pred` (dev transforms on demand — generous windows). */
async function wait_html(pred: (html: string) => boolean, ms = 15_000): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const html = await fetch_html();
		if (html && pred(html)) return html;
		await sleep(400);
	}
	return null;
}

// hoisted probes — one compile each, reused across every poll tick
const REGION_RE = /<ogygia-region[\s/>]/;
const KIT_BOOT_RE = /__sveltekit_\w+\s*=/;
const RUNTIME_RE = /data-ogygia-runtime/;
const has_regions = (h: string) => REGION_RE.test(h);
const kit_booted = (h: string) => KIT_BOOT_RE.test(h);

// ── boot the dev server ─────────────────────────────────────────────────────────────────────
// detached = its own process GROUP, so teardown kills the real vite child too — killing just the
// pnpm wrapper orphans vite, which then squats the port for every later run.
// `--host 127.0.0.1` pins the bind family — vite 8's default `localhost` bind can come up
// IPv6-only (`::1`), and this harness polls IPv4.
const srv = spawn(
	'pnpm',
	['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
	{ env: { ...process.env }, stdio: 'ignore', detached: true }
);
const kill_server = () => {
	try {
		process.kill(-srv.pid!, 'SIGTERM');
	} catch {
		srv.kill();
	}
};
const orig = readFileSync(page_ts, 'utf8');
try {
	const first = await wait_html(() => true, 120_000);
	if (!first) {
		console.error('\x1b[31m✗ playground dev server never came up\x1b[0m');
		kill_server();
		process.exit(1);
	}

	// Baseline: csr=true leaf → chrome degraded inline, Kit boots the page.
	check('dev baseline: csr=true page has NO <ogygia-region>', !has_regions(first));
	check('dev baseline: Kit bootstrap present', kit_booted(first));

	// ── flip the leaf to csr=false — the server's set must refresh, not desync ──────────────
	writeFileSync(page_ts, 'export const csr = false;\n');
	const flipped = await wait_html((h) => has_regions(h) && !kit_booted(h), 30_000);
	check(
		'after toggle → csr=false: chrome is ISLANDS again + no Kit bootstrap (set refreshed)',
		!!flipped
	);
	if (flipped)
		check(
			'after toggle: island runtime is served with the regions (no dead chrome)',
			RUNTIME_RE.test(flipped)
		);

	// ── flip back — the other direction must refresh too ────────────────────────────────────
	writeFileSync(page_ts, orig);
	const restored = await wait_html((h) => !has_regions(h) && kit_booted(h), 30_000);
	check('after restore → csr=true: degraded inline again (no stale island shells)', !!restored);
} finally {
	writeFileSync(page_ts, orig);
	kill_server();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} dev-csr-toggle check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL DEV-CSR-TOGGLE CHECKS PASSED\x1b[0m');
