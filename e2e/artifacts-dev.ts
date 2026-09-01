// ARTIFACTS, the DEV leg: `vite dev` must NEVER serve or fill the store — an edited page has to
// re-render every time (HMR truth beats byte reuse). The purity verdict still runs and teaches:
// eligible pages carry `x-ogygia-artifact: would-store`, refusals a named console note.
// Self-contained: boots the repro-artifacts DEV server, fetches, tears down.
// Usage: node e2e/artifacts-dev.ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = join(repo, 'internal', 'repro-artifacts');
const PORT = 3077;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// detached = its own process GROUP, so teardown kills the real vite child too (the pnpm-wrapper
// orphan squats the port otherwise); `--host 127.0.0.1` pins the bind family (vite's `localhost`
// can come up IPv6-only while this harness polls IPv4).
const srv = spawn(
	'pnpm',
	['--dir', dir, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
	{ env: { ...process.env }, stdio: 'ignore', detached: true }
);
const kill_server = () => {
	try {
		process.kill(-srv.pid!, 'SIGTERM');
	} catch {
		srv.kill();
	}
};

try {
	let up = false;
	for (let i = 0; i < 240 && !up; i++) {
		try {
			up = (await fetch(base + '/api/state')).ok;
		} catch {
			await sleep(500);
		}
	}
	if (!up) {
		console.error('\x1b[31m✗ repro-artifacts dev server never came up\x1b[0m');
		kill_server();
		process.exit(1);
	}

	const renders = async (): Promise<Record<string, number>> =>
		(await (await fetch(base + '/api/state')).json()).renders ?? {};

	// An ELIGIBLE page: renders EVERY time in dev (no store), flagged `would-store`.
	const r1 = await fetch(base + '/fr/fr/c/home');
	const r2 = await fetch(base + '/fr/fr/c/home');
	check('dev: eligible page never served from the store', r2.headers.get('x-ogygia-artifact') === 'would-store', r2.headers.get('x-ogygia-artifact') ?? '(none)');
	check('dev: first response taught the same', r1.headers.get('x-ogygia-artifact') === 'would-store');
	check('dev: every request re-rendered', ((await renders())['/fr/fr/c/home'] ?? 0) === 2, String((await renders())['/fr/fr/c/home']));

	// A REFUSED page: no would-store, still re-renders (the named console note is dev-server-side).
	await fetch(base + '/fr/fr/flagged');
	const f2 = await fetch(base + '/fr/fr/flagged');
	check('dev: refused page carries no would-store', f2.headers.get('x-ogygia-artifact') === null, f2.headers.get('x-ogygia-artifact') ?? '(none)');
	check('dev: refused page re-rendered too', ((await renders())['/fr/fr/flagged'] ?? 0) === 2);
} finally {
	kill_server();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} ARTIFACTS-DEV check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL ARTIFACTS-DEV CHECKS PASSED\x1b[0m');
