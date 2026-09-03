// PAGE-CSR, the DEV leg: toggling a `csr` export must refresh the SERVER's csr_true_routes —
// `virtual:ogygia/route-csr` lives in the dev SSR module graph, and before the fix it was baked
// once and NEVER invalidated: Kit flipped immediately while ogygia's server leg kept deciding
// island-vs-inline from the stale set → `<ogygia-region>` shells on a Kit-booted page with the
// runtime withheld = dead chrome (the consumer-reported desync the docstring says can't happen).
// Self-contained: boots the playground DEV server, fetches, toggles the file, re-fetches, restores.
// Usage: pnpm exec playwright test dev-csr-toggle
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, check, sleep } from './fixtures/index.ts';
import { KIT_BOOT_RE, REGION_TAG_RE, RUNTIME_SCRIPT_RE } from './fixtures/re.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const page_ts = join(playground, 'src', 'routes', 'csr-chrome', 'kit', '+page.ts');
const PORT = 3079;
const base = `http://127.0.0.1:${PORT}`;
const URL_PATH = '/csr-chrome/kit/';

// probes reused across every poll tick
const has_regions = (h: string) => REGION_TAG_RE.test(h);
const kit_booted = (h: string) => KIT_BOOT_RE.test(h);

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

let srv: SpawnedServer | undefined;
let orig: string | undefined;

test.describe('PAGE-CSR dev leg: a csr-export toggle refreshes virtual:ogygia/route-csr (stale set = island shells + Kit boot + no runtime = dead chrome)', () => {
	// ── boot the dev server ─────────────────────────────────────────────────────────────────────
	// spawn_server = its own process GROUP, so teardown kills the real vite child too — killing just
	// the pnpm wrapper orphans vite, which then squats the port for every later run.
	// `--host 127.0.0.1` pins the bind family — vite 8's default `localhost` bind can come up
	// IPv6-only (`::1`), and this harness polls IPv4.
	test.beforeAll(async () => {
		orig = readFileSync(page_ts, 'utf8');
		srv = await spawn_server({
			cmd: 'pnpm',
			args: [
				'--dir',
				playground,
				'dev',
				'--port',
				String(PORT),
				'--strictPort',
				'--host',
				'127.0.0.1'
			],
			cwd: playground,
			url: base + '/',
			timeout_ms: 120_000
		});
	});
	test.afterAll(() => {
		if (orig !== undefined) writeFileSync(page_ts, orig);
		srv?.kill();
	});

	test('toggling the leaf csr export refreshes the server set in BOTH directions', async () => {
		try {
			const first = await wait_html(() => true, 120_000);
			expect(first, 'playground dev server never came up').not.toBeNull();

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
					RUNTIME_SCRIPT_RE.test(flipped)
				);

			// ── flip back — the other direction must refresh too ────────────────────────────────────
			writeFileSync(page_ts, orig);
			const restored = await wait_html((h) => !has_regions(h) && kit_booted(h), 30_000);
			check('after restore → csr=true: degraded inline again (no stale island shells)', !!restored);
		} finally {
			writeFileSync(page_ts, orig);
		}
	});
});
