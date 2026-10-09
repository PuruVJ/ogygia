// DEV: a server island's signed endpoint must keep answering after an HMR edit of its HOST file.
//
//   pnpm exec playwright test dev-hole-hmr
//
// The regression: editing a host dropped its islands' registry rows and invalidated
// `virtual:ogygia/server-manifest`; Kit re-imported the handle BEFORE the page transform
// re-registered them, so the handle held a manifest WITHOUT those ids — and nothing invalidated it
// again. Every hole on the page answered 403 until the dev server was restarted (the bcms header
// lab: all five holes dead after any edit to Header.svelte). The driver now re-invalidates the
// manifest when a transform registers a server id the last emit lacked.
// Self-contained: boots the playground DEV server, fetches a hole, edits the host, re-fetches.
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
// The lake-kit chrome: a HOST that places the `Greeting` deferred hole (and the Kept hole).
const host = join(playground, 'src', 'lib', 'lakes', 'LakeChrome.svelte');
const PORT = 3081;
const base = `http://127.0.0.1:${PORT}`;
// Visible text (an HTML comment would be dropped from the SSR output).
const MARK = 'DEV_HOLE_HMR_MARK';

let srv: SpawnedServer | null = null;
let original: string | null = null;

async function hole_status(): Promise<{ page: number; hole: number; endpoint: string }> {
	const res = await fetch(`${base}/lake-kit/`);
	const html = await res.text();
	// The LAST hole in the page is Kept (rendered after Greeting in LakeChrome): LakeChrome is its
	// ONLY host. Greeting is hosted by many pages and keeps its id when this host is unregistered
	// (shared ids are refcounted), which would hide the bug. (A deferred `wake: 'load'` hole emits
	// no `wake` attribute — `when="load"` is the fetch schedule — so the tag can't be told by it.)
	const all = [...html.matchAll(/<ogygia-region[^>]*render="defer"[^>]*endpoint="([^"]+)"/g)];
	const endpoint = (all.at(-1)?.[1] ?? '').replace(/&amp;/g, '&');
	if (!endpoint) return { page: res.status, hole: 0, endpoint: '' };
	// The endpoint is page-relative (`./__ogygia__?…`); resolve it against the page URL.
	const url = new URL(endpoint, `${base}/lake-kit/`).toString();
	const hole = await fetch(url, { headers: { 'sec-fetch-site': 'same-origin' } });
	return { page: res.status, hole: hole.status, endpoint: url };
}

test.describe('dev: hole endpoint survives an HMR edit of its host', () => {
	test.beforeAll(async () => {
		srv = await spawn_server({
			cmd: 'pnpm',
			args: ['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
			cwd: repo,
			url: `${base}/lake-kit/`,
			timeout_ms: 120_000
		});
	});

	test.afterAll(() => {
		if (original != null) fs.writeFileSync(host, original);
		srv?.kill();
	});

	test('hole answers before AND after the host file changes', async () => {
		test.setTimeout(120_000);
		const before = await hole_status();
		check('page renders (dev)', before.page === 200, `status=${before.page}`);
		// The DEV bridge (it imports `@vite/client`) must be on a csr=false page so Vite's own
		// full-reload recovery reaches it after a dep re-optimization rotates the optimizer hash —
		// Kit ships no client bootstrap under csr=false, so nothing else injects the Vite client.
		const dev_html = await (await fetch(`${base}/lake-kit/`)).text();
		check('csr=false page carries the dev bridge (@vite/client recovery)', /data-ogygia-dev-hmr/.test(dev_html));
		const bridge = await (await fetch(`${base}/@id/virtual:ogygia/dev-hmr`)).text();
		check('the dev bridge imports @vite/client', bridge.includes('@vite/client'), bridge.slice(0, 60));
		check('a hole endpoint is in the page', before.endpoint !== '', before.endpoint);
		check(
			'hole answers before the edit (200 or 204)',
			before.hole === 200 || before.hole === 204,
			`status=${before.hole}`
		);

		// HMR: edit the HOST's own markup (the islands it places keep their ids).
		original = fs.readFileSync(host, 'utf8');
		check('host has the anchor to edit', original.includes('lake chrome ('));
		fs.writeFileSync(host, original.replace('lake chrome (', `lake chrome ${MARK} (`));
		await sleep(1500);

		// The page must reflect the edit (proves the host was re-transformed), and the hole must
		// STILL answer — before the fix this was a 403 ("id not in the server manifest").
		const page_after = await (await fetch(`${base}/lake-kit/`)).text();
		check('host edit reached the page (HMR)', page_after.includes(MARK));
		const after = await hole_status();
		check(
			'hole answers after the host edit (200 or 204, not 403)',
			after.hole === 200 || after.hole === 204,
			`status=${after.hole}`
		);
		check(
			'dev log: no "not in the server manifest" 403',
			!srv!.logs.join('').includes('not in the server manifest'),
			srv!.tail(5)
		);

		fs.writeFileSync(host, original);
		original = null;
	});
});
