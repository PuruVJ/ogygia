// A server window on a serverless deployment: start, the session's requests and stop each land on
// whichever instance. Two `vite preview`s of one build share a profiler store (the same database file),
// as instances behind a load balancer share redis or postgres. A request tagged with the window's id is
// written to the store by the instance that served it, and stop — on either instance — gathers them.
import { test, expect, request as pw_request, type APIRequestContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn_server, type SpawnedServer } from '@ogygia/tooling/e2e/servers.ts';

const KEY = 'e2e-window';
// (the devtools lab, built by this suite's globalSetup)
const app = fileURLToPath(new URL('./app', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'og-window-'));
const db = join(dir, 'shared.db');
const PORTS = [3102, 3103];
const servers: SpawnedServer[] = [];
const api: APIRequestContext[] = [];

test.beforeAll(async () => {
	for (const port of PORTS) {
		const origin = `http://localhost:${port}`;
		servers.push(
			await spawn_server({
				cmd: 'node',
				args: ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'],
				cwd: app,
				env: { ORIGIN: origin, OGYGIA_PROFILER_SECRET: KEY, OGYGIA_PROFILES_DB: db },
				url: `${origin}/robots.txt`
			})
		);
		// (an Origin header: a SvelteKit app refuses a cross-site POST without one)
		api.push(
			await pw_request.newContext({
				baseURL: origin,
				extraHTTPHeaders: { 'x-profiler-key': KEY, origin, accept: 'application/json' }
			})
		);
	}
});
test.afterAll(async () => {
	for (const a of api) await a.dispose();
	for (const s of servers) s.kill();
	rmSync(dir, { recursive: true, force: true });
});

test('a window started on one instance gathers the requests every instance served, and stops on any', async () => {
	test.setTimeout(120_000);
	const [a, b] = api;
	const start = await (await a.post('/__profiler/window/start')).json();
	expect(start).toMatchObject({ ok: true, header: 'x-og-window', shared: true });
	const tag = { [start.header]: start.id };
	// the session's requests: one on each instance, and one untagged that is not the window's
	expect((await a.get('/interaction', { headers: tag })).status()).toBe(200);
	expect((await b.get('/dt-lab', { headers: tag })).status()).toBe(200);
	await b.get('/wake-gate');
	// stop on the OTHER instance: it never held the window, it gathers what the store has
	const stopped = await b.post('/__profiler/window/stop', { headers: tag });
	expect(stopped.status()).toBe(200);
	const body = await stopped.json();
	expect(body.window.requests.map((r: { path: string }) => r.path).sort()).toEqual([
		'/dt-lab',
		'/interaction'
	]);
	expect(body.window.instances).toBe(2);
	expect(body.window.requests.every((r: { cpu_ms: number }) => typeof r.cpu_ms === 'number')).toBe(
		true
	);

	// a forged id is not the window's: nothing is written for it
	const forged = { [start.header]: start.id.split('.')[0] + '.0000000000' };
	await b.get('/interaction', { headers: forged });
	const again = await (await b.post('/__profiler/window/stop', { headers: tag })).json();
	expect(again.window.requests).toHaveLength(2);
});

test('stopped on the instance that started it: its CPU profile and every instance’s requests', async () => {
	test.setTimeout(120_000);
	const [a, b] = api;
	// (the first test's window still holds instance A's recorder until its cap: wait it out on a 409)
	let start: { id: string; header: string } | null = null;
	for (let i = 0; i < 40 && !start; i++) {
		const r = await a.post('/__profiler/window/start');
		if (r.status() === 200) start = await r.json();
		else await new Promise((ok) => setTimeout(ok, 2000));
	}
	expect(start).not.toBeNull();
	const tag = { [start!.header]: start!.id };
	await a.get('/interaction', { headers: tag });
	await b.get('/dt-lab', { headers: tag });
	const body = await (await a.post('/__profiler/window/stop', { headers: tag })).json();
	expect(body.engine).toMatchObject({ version: 3 });
	expect(body.window.instances).toBe(2);
	expect(body.window.requests.map((r: { path: string }) => r.path).sort()).toEqual([
		'/dt-lab',
		'/interaction'
	]);
});
