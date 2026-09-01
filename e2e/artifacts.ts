// ARTIFACTS — the scenario deck over a REAL build of internal/repro-artifacts, behind the
// chained edge emulators (user → akamai-emu → cloudfront-emu → origin, the bcms topology).
// One deck, the lanes vary (internal/notes/artifact.md, §Test harness): origin store (tier 1)
// is exercised directly; the edge lane runs through emulators that speak each CDN's REAL purge
// API — ogygia's actual adapters sign and call them unchanged.
// Self-contained: builds the fixture, boots origin + emulators, runs, tears down.
// Usage: node e2e/artifacts.ts
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { start_edge_emulator } from './artifacts-emulator.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = join(repo, 'internal', 'repro-artifacts');
const ORIGIN_PORT = 3073;
const AKAMAI_PORT = 3074;
const CF_PORT = 3075;
const origin = `http://127.0.0.1:${ORIGIN_PORT}`;
const edge = `http://127.0.0.1:${AKAMAI_PORT}`; // the user-facing layer of the chain

let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// hoisted probes
const KIT_BOOT_RE = /__sveltekit_\w+/;
const AMP_RE = /&amp;/g; // attr-escaped HTML — normalize before URL-shaped regexes
const HOLE_ENDPOINT_RE = /__ogygia__\?id=[^"&]+&props=[^"&]+&exp=(\d+)/;
// Served-from-store copies carry the doc marker; the ONE capture response doesn't (by design —
// live regions read it to self-freshen). Strip before byte-identity comparisons.
const DOC_MARKER_RE = /<meta name="ogygia-artifact"[^>]*>/;

const renders = async (): Promise<Record<string, number>> =>
	(await (await fetch(origin + '/api/state')).json()).renders ?? {};
const artifact_via = (res: Response) => res.headers.get('x-ogygia-artifact') ?? '';

// ── 1. build the fixture (consumes the live workspace ogygia) ───────────────────────────────
const built = spawnSync('pnpm', ['--dir', dir, 'build'], { stdio: 'inherit' });
if (built.status !== 0) {
	console.error('\x1b[31m✗ repro-artifacts build failed\x1b[0m');
	process.exit(1);
}

// ── 2. boot the chain: emulators first (origin adapters purge INTO them) ────────────────────
const cf = await start_edge_emulator({ name: 'cloudfront', port: CF_PORT, upstream: origin });
const akamai = await start_edge_emulator({ name: 'akamai', port: AKAMAI_PORT, upstream: cf.base });
const srv = spawn('node', ['build/index.js'], {
	cwd: dir,
	env: {
		...process.env,
		PORT: String(ORIGIN_PORT),
		ORIGIN: origin,
		EDGE_AKAMAI_URL: akamai.base,
		EDGE_CF_URL: cf.base,
		EDGE_SITE_URL: origin
	},
	stdio: 'ignore'
});
let up = false;
for (let i = 0; i < 80 && !up; i++) {
	try {
		up = (await fetch(origin + '/api/state')).ok;
	} catch {
		await sleep(250);
	}
}
if (!up) {
	console.error('\x1b[31m✗ repro-artifacts server never came up\x1b[0m');
	srv.kill();
	process.exit(1);
}

try {
	// ── S1: cold → warm → edge ────────────────────────────────────────────────────────────────
	const r1 = await fetch(edge + '/fr/fr/c/home');
	const h1 = await r1.text();
	check('S1 cold: rendered through the chain', h1.includes('content of home v1'));
	check('S1 cold: origin stored it', artifact_via(r1) === 'stored', artifact_via(r1));
	check('S1 cold: both edges missed', r1.headers.get('x-edge-akamai') === 'miss');
	const r2 = await fetch(origin + '/fr/fr/c/home');
	check('S1 warm origin: served from the store', artifact_via(r2) === 'hit');
	const r3 = await fetch(edge + '/fr/fr/c/home');
	check('S1 edge: akamai answered from its own copy', r3.headers.get('x-edge-akamai') === 'hit');
	check('S1: ONE render total', (await renders())['/fr/fr/c/home'] === 1, JSON.stringify(await renders()));

	// ── S2: publish → exact URL purge everywhere → ONE re-render ─────────────────────────────
	const pub = await fetch(origin + '/api/publish', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ slug: 'home' })
	});
	check('S2 publish: webhook ok', (await pub.json()).ok === true);
	check(
		'S2 publish: akamai got a SIGNED url purge',
		akamai.state().purges.some((p) => p.kind === 'url' && p.value === '/fr/fr/c/home' && p.auth_ok)
	);
	check(
		'S2 publish: cloudfront got a SIGNED path invalidation',
		cf.state().purges.some((p) => p.kind === 'path' && p.value === '/fr/fr/c/home' && p.auth_ok)
	);
	const r4 = await fetch(edge + '/fr/fr/c/home');
	check('S2 after publish: fresh content', (await r4.text()).includes('content of home v2'));
	check('S2 after publish: exactly one more render', (await renders())['/fr/fr/c/home'] === 2);

	// ── S3: prefix nuke (the locale case) ─────────────────────────────────────────────────────
	await fetch(edge + '/fr/fr/c/about');
	await fetch(edge + '/en/us/c/home');
	await fetch(origin + '/api/publish', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ prefix: '/fr/fr' })
	});
	check(
		'S3 nuke: akamai got the PREFIX TAG purge',
		akamai.state().purges.some((p) => p.kind === 'tag' && p.value === 'p:/fr/fr')
	);
	check(
		'S3 nuke: cloudfront got the wildcard',
		cf.state().purges.some((p) => p.kind === 'path' && p.value === '/fr/fr/*')
	);
	await fetch(edge + '/fr/fr/c/about');
	await fetch(edge + '/en/us/c/home');
	const after_nuke = await renders();
	check('S3 nuke: the fr subtree re-rendered once more', after_nuke['/fr/fr/c/about'] === 2);
	check('S3 nuke: the en tree was untouched', after_nuke['/en/us/c/home'] === 1, String(after_nuke['/en/us/c/home']));

	// ── S4: the vary law (CDN cookie-less-key semantics, formalized) ─────────────────────────
	// Cookied-FIRST on a fresh URL: non-default read → never stores while only cookied traffic.
	await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
	await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
	check('S4 cookied-first: stays per-request', (await renders())['/fr/fr/consent'] === 2);
	// An anonymous render then mints the canonical…
	const anon = await fetch(origin + '/fr/fr/consent');
	check('S4 anon: canonical stored', artifact_via(anon) === 'stored');
	// …and (the documented cookie-less-key trade-off) a cookied visitor now gets the canonical.
	const cookied = await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
	check('S4 cookied-after: served the canonical copy', artifact_via(cookied) === 'hit');
	check('S4: renders stopped at 3', (await renders())['/fr/fr/consent'] === 3);

	// ── S5: never-store guards ────────────────────────────────────────────────────────────────
	for (const [path, why] of [
		['/fr/fr/setcookie', 'set-cookie response'],
		['/fr/fr/stream', 'streamed load'],
		['/fr/fr/flagged', 'flag read (A/B)']
	] as const) {
		await fetch(origin + path);
		const second = await fetch(origin + path);
		check(`S5 ${why}: never stored`, artifact_via(second) === '', artifact_via(second) || '(none)');
		check(`S5 ${why}: re-rendered`, ((await renders())[path] ?? 0) === 2);
	}

	// ── S6: holes — frozen shell, fresh hole, prerender-grade capability ─────────────────────
	const hole1 = await fetch(origin + '/fr/fr/hole');
	const hole1_html = (await hole1.text()).replace(AMP_RE, '&');
	const exp = Number(HOLE_ENDPOINT_RE.exec(hole1_html)?.[1] ?? 0);
	check('S6: shell stored', artifact_via(hole1) === 'stored');
	check(
		'S6: hole capability is PRERENDER-GRADE (outlives regionTtl)',
		exp > Date.now() / 1000 + 86400 * 30,
		`exp=${exp}`
	);
	const hole2 = await fetch(origin + '/fr/fr/hole');
	check('S6: second shell is the stored copy', artifact_via(hole2) === 'hit');
	check('S6: shell rendered once', (await renders())['/fr/fr/hole'] === 1);
	// Browser leg: the hole FETCHES FRESH per visit while the shell stays frozen.
	{
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(origin + '/fr/fr/hole', { waitUntil: 'networkidle' });
			const serial_a = (await page.locator('[data-hole-serial]').textContent({ timeout: 8000 }))?.trim();
			await page.goto('about:blank');
			await page.goto(origin + '/fr/fr/hole', { waitUntil: 'networkidle' });
			const serial_b = (await page.locator('[data-hole-serial]').textContent({ timeout: 8000 }))?.trim();
			check('S6 browser: hole content is fresh per visit', !!serial_a && !!serial_b && serial_a !== serial_b, `${serial_a} vs ${serial_b}`);
			check('S6 browser: shell STILL rendered once', (await renders())['/fr/fr/hole'] === 1);
		} finally {
			await browser.close();
		}
	}

	// ── S7: stored redirects ──────────────────────────────────────────────────────────────────
	const red1 = await fetch(origin + '/fr/fr/redirect-me', { redirect: 'manual' });
	check('S7: 301 with location', red1.status === 301 && red1.headers.get('location') === '/fr/fr/c/home');
	const red2 = await fetch(origin + '/fr/fr/redirect-me', { redirect: 'manual' });
	check('S7: second redirect served from the store', artifact_via(red2) === 'hit');
	check('S7: redirect rendered once', (await renders())['/fr/fr/redirect-me'] === 1);

	// ── S8: action self-evict ─────────────────────────────────────────────────────────────────
	await fetch(origin + '/fr/fr/act');
	const act_warm = await fetch(origin + '/fr/fr/act');
	check('S8: stored before the action', artifact_via(act_warm) === 'hit');
	const post = await fetch(origin + '/fr/fr/act', {
		method: 'POST',
		headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
		body: '',
		redirect: 'manual'
	});
	check('S8: action succeeded', post.status < 400, String(post.status));
	const act_after = await fetch(origin + '/fr/fr/act');
	check('S8: the action EVICTED its page (fresh render, fresh tally)', /data-tally[^>]*>1</.test(await act_after.text()));
	check('S8: render count grew', (await renders())['/fr/fr/act'] === 2);

	// ── S9: stampede — the single-flight law ──────────────────────────────────────────────────
	const volley = await Promise.all(
		Array.from({ length: 50 }, () => fetch(origin + '/fr/fr/c/stampede'))
	);
	check('S9: all 50 answered 200', volley.every((r) => r.status === 200));
	const bodies = await Promise.all(volley.map((r) => r.text()));
	check(
		'S9: all identical bytes (modulo the doc marker joins carry)',
		new Set(bodies.map((b) => b.replace(DOC_MARKER_RE, ''))).size === 1
	);
	check(
		'S9: exactly ONE capture response, the rest served copies',
		volley.filter((r) => artifact_via(r) === 'stored').length === 1
	);
	check('S9: ONE render for 50 concurrent colds', (await renders())['/fr/fr/c/stampede'] === 1, String((await renders())['/fr/fr/c/stampede']));

	// ── S10: csr=true page stores the same (csr-agnostic) ────────────────────────────────────
	const spa1 = await fetch(origin + '/spa');
	check('S10: Kit-booted page', KIT_BOOT_RE.test(await spa1.text()));
	const spa2 = await fetch(origin + '/spa');
	check('S10: stored + served', artifact_via(spa2) === 'hit');
	check('S10: one render', (await renders())['/spa'] === 1);

	// ── S11: failure injection — one edge down never fails a publish ─────────────────────────
	await fetch(akamai.base + '/__edge/fail', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"mode":"purge-500"}'
	});
	const pub2 = await fetch(origin + '/api/publish', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ slug: 'home' })
	});
	check('S11: publish still succeeds with akamai purge DOWN', (await pub2.json()).ok === true);
	const r5 = await fetch(origin + '/fr/fr/c/home');
	check('S11: origin still evicted + re-rendered (v3)', (await r5.text()).includes('content of home v3'));
	await fetch(akamai.base + '/__edge/fail', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"mode":"none"}'
	});

	// ── S12: og.source PRECISION — one embedded doc, every consuming page evicted ────────────
	// Warm three pages across TWO locales; all embed the shared 'promo' doc via a declared
	// source. A doc publish must evict exactly the consumers (reverse-index receipts), origin
	// AND edges — including the en page a prefix nuke could never reach precisely.
	await fetch(origin + '/fr/fr/c/home');
	await fetch(origin + '/fr/fr/c/about');
	await fetch(origin + '/en/us/c/home');
	const counts_before = await renders();
	const pub3 = await fetch(origin + '/api/publish', {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ doc: 'promo' })
	});
	check('S12 doc publish: webhook ok', (await pub3.json()).ok === true);
	for (const path of ['/fr/fr/c/home', '/fr/fr/c/about', '/en/us/c/home'] as const) {
		check(
			`S12: akamai got the url purge for CONSUMER ${path}`,
			akamai.state().purges.some((p) => p.kind === 'url' && p.value === path)
		);
	}
	const promo1 = await fetch(origin + '/fr/fr/c/home');
	check('S12: consumer re-rendered with the fresh doc', /data-promo[^>]*>2</.test(await promo1.text()));
	await fetch(origin + '/fr/fr/c/about');
	await fetch(origin + '/en/us/c/home');
	const counts_after = await renders();
	for (const path of ['/fr/fr/c/home', '/fr/fr/c/about', '/en/us/c/home'] as const) {
		check(
			`S12: ${path} re-rendered exactly once`,
			(counts_after[path] ?? 0) === (counts_before[path] ?? 0) + 1,
			`${counts_before[path]} -> ${counts_after[path]}`
		);
	}
	// A TRUE non-consumer: every c/[slug] load reads the doc (stampede included), but the consent
	// canonical never did — its artifact must survive the doc publish untouched.
	const bystander = await fetch(origin + '/fr/fr/consent');
	check('S12: a non-consumer page was untouched', artifact_via(bystander) === 'hit');

	// ── S13: render:'live' inside a stored page — the self-freshening header ─────────────────
	// The shell stores; the header is a live lake BAKED into the bytes (no fallback flash),
	// hosted by a small island. Served-from-store documents carry the doc marker, so the lake
	// revalidates on FIRST mount: a fresh SERVER render carrying the visitor's cookies, swapped
	// in. Canonical for anonymous, personal for the visitor — on a page that never re-renders.
	const lh1 = await fetch(origin + '/fr/fr/live-header');
	check('S13: shell stored', artifact_via(lh1) === 'stored');
	check('S13: header baked as canonical (guest) in the first bytes', (await lh1.text()).includes('Hello, guest'));
	const lh2 = await fetch(origin + '/fr/fr/live-header');
	const lh2_html = await lh2.text();
	check(
		'S13: second serve is the stored copy + carries the doc marker',
		artifact_via(lh2) === 'hit' && lh2_html.includes('name="ogygia-artifact"')
	);
	{
		const browser = await chromium.launch();
		try {
			const bctx = await browser.newContext();
			await bctx.addCookies([{ name: 'user', value: 'Puru', url: origin }]);
			const bpage = await bctx.newPage();
			await bpage.goto(origin + '/fr/fr/live-header', { waitUntil: 'domcontentloaded' });
			await bpage
				.waitForFunction(
					() => document.querySelector('[data-hello]')?.textContent?.includes('Puru'),
					null,
					{ timeout: 10000 }
				)
				.catch(() => {});
			const hello = (await bpage.locator('[data-hello]').textContent())?.trim();
			check(
				'S13 browser: header self-freshened to the VISITOR (cookies, on a stored page)',
				hello === 'Hello, Puru',
				hello ?? ''
			);
			check('S13 browser: shell STILL rendered once', (await renders())['/fr/fr/live-header'] === 1);
		} finally {
			await browser.close();
		}
	}
} finally {
	srv.kill();
	await akamai.close();
	await cf.close();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} ARTIFACTS check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL ARTIFACTS CHECKS PASSED\x1b[0m');
