// FREEZE — the scenario deck over a REAL build of internal/repro-freeze, behind the
// chained edge emulators (user → akamai-emu → cloudfront-emu → origin, the bcms topology).
// One deck, the lanes vary (internal/notes/freeze.md, §Test harness): origin store (tier 1)
// is exercised directly; the edge lane runs through emulators that speak each CDN's REAL purge
// API — ogygia's actual adapters sign and call them unchanged.
// Self-contained: builds the fixture, boots origin + emulators, runs, tears down.
// Usage: pnpm exec playwright test freeze
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test, expect, check } from './fixtures/index.ts';
import { AMP_ENTITY_G_RE, FREEZE_META_RE, REGION_ENDPOINT_URL_RE } from './fixtures/re.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';
import { start_edge_emulator, type EdgeEmulator } from './freeze-emulator.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = join(repo, 'internal', 'repro-freeze');
const ORIGIN_PORT = 3073;
const AKAMAI_PORT = 3074;
const CF_PORT = 3075;
const origin = `http://127.0.0.1:${ORIGIN_PORT}`;
const edge = `http://127.0.0.1:${AKAMAI_PORT}`; // the user-facing layer of the chain

// hoisted probes
const KIT_BOOT_RE = /__sveltekit_\w+/;
const TALLY_ONE_RE = /data-tally[^>]*>1</;
const PROMO_TWO_RE = /data-promo[^>]*>2</;

const renders = async (): Promise<Record<string, number>> =>
	(await (await fetch(origin + '/api/state')).json()).renders ?? {};
const freeze_via = (res: Response) => res.headers.get('x-ogygia-freeze') ?? '';

let cf: EdgeEmulator | undefined;
let akamai: EdgeEmulator | undefined;
let srv: SpawnedServer | undefined;

test.describe('FREEZE (render-on-write): store/serve/invalidate + prefix nuke + edge emulators (real adapter signing) + stampede single-flight + holes prerender-grade (self-building fixture)', () => {
	test.beforeAll(async () => {
		test.setTimeout(15 * 60_000);
		// ── 1. build the fixture (consumes the live workspace ogygia) ───────────────────────────────
		const built = spawnSync('pnpm', ['--dir', dir, 'build'], { stdio: 'inherit' });
		expect(built.status, 'repro-freeze build').toBe(0);

		// ── 2. boot the chain: emulators first (origin adapters purge INTO them) ────────────────────
		cf = await start_edge_emulator({ name: 'cloudfront', port: CF_PORT, upstream: origin });
		akamai = await start_edge_emulator({ name: 'akamai', port: AKAMAI_PORT, upstream: cf.base });
		srv = await spawn_server({
			cmd: 'node',
			args: ['build/index.js'],
			cwd: dir,
			env: {
				PORT: String(ORIGIN_PORT),
				ORIGIN: origin,
				EDGE_AKAMAI_URL: akamai.base,
				EDGE_CF_URL: cf.base,
				EDGE_SITE_URL: origin
			},
			url: origin + '/api/state',
			ready: (res) => res.ok
		});
	});
	test.afterAll(async () => {
		srv?.kill();
		await akamai?.close();
		await cf?.close();
	});

	// The deck is ONE serial story: render counts, purge logs and stored copies carry forward from
	// scenario to scenario (S2 expects S1's single render, S12 diffs counts, S14 reads the copy
	// S11 minted), so it stays one test — every check is soft, so a failure never hides the rest.
	test('the deck: S1 cold→warm→edge … S15 serve-time stitching', async ({ page, context }) => {
		// ── S1: cold → warm → edge ────────────────────────────────────────────────────────────────
		const r1 = await fetch(edge + '/fr/fr/c/home');
		const h1 = await r1.text();
		check('S1 cold: rendered through the chain', h1.includes('content of home v1'));
		check('S1 cold: origin stored it', freeze_via(r1) === 'stored', freeze_via(r1));
		check('S1 cold: both edges missed', r1.headers.get('x-edge-akamai') === 'miss');
		const r2 = await fetch(origin + '/fr/fr/c/home');
		check('S1 warm origin: served from the store', freeze_via(r2) === 'hit');
		const r3 = await fetch(edge + '/fr/fr/c/home');
		check('S1 edge: akamai answered from its own copy', r3.headers.get('x-edge-akamai') === 'hit');
		check(
			'S1: ONE render total',
			(await renders())['/fr/fr/c/home'] === 1,
			JSON.stringify(await renders())
		);

		// ── S2: publish → exact URL purge everywhere → ONE re-render ─────────────────────────────
		const pub = await fetch(origin + '/api/publish', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin },
			body: JSON.stringify({ slug: 'home' })
		});
		check('S2 publish: webhook ok', (await pub.json()).ok === true);
		check(
			'S2 publish: akamai got a SIGNED url purge',
			akamai!
				.state()
				.purges.some((p) => p.kind === 'url' && p.value === '/fr/fr/c/home' && p.auth_ok)
		);
		check(
			'S2 publish: cloudfront got a SIGNED path invalidation',
			cf!.state().purges.some((p) => p.kind === 'path' && p.value === '/fr/fr/c/home' && p.auth_ok)
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
			akamai!.state().purges.some((p) => p.kind === 'tag' && p.value === 'p:/fr/fr')
		);
		check(
			'S3 nuke: cloudfront got the wildcard',
			cf!.state().purges.some((p) => p.kind === 'path' && p.value === '/fr/fr/*')
		);
		await fetch(edge + '/fr/fr/c/about');
		await fetch(edge + '/en/us/c/home');
		const after_nuke = await renders();
		check('S3 nuke: the fr subtree re-rendered once more', after_nuke['/fr/fr/c/about'] === 2);
		check(
			'S3 nuke: the en tree was untouched',
			after_nuke['/en/us/c/home'] === 1,
			String(after_nuke['/en/us/c/home'])
		);

		// ── S4: the vary law (CDN cookie-less-key semantics, formalized) ─────────────────────────
		// Cookied-FIRST on a fresh URL: non-default read → never stores while only cookied traffic.
		await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
		await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
		check('S4 cookied-first: stays per-request', (await renders())['/fr/fr/consent'] === 2);
		// An anonymous render then mints the canonical…
		const anon = await fetch(origin + '/fr/fr/consent');
		check('S4 anon: canonical stored', freeze_via(anon) === 'stored');
		// …and (the documented cookie-less-key trade-off) a cookied visitor now gets the canonical.
		const cookied = await fetch(origin + '/fr/fr/consent', { headers: { cookie: 'consent=yes' } });
		check('S4 cookied-after: served the canonical copy', freeze_via(cookied) === 'hit');
		check('S4: renders stopped at 3', (await renders())['/fr/fr/consent'] === 3);

		// ── S5: never-store guards ────────────────────────────────────────────────────────────────
		for (const [path, why] of [
			['/fr/fr/setcookie', 'set-cookie response'],
			['/fr/fr/stream', 'streamed load'],
			['/fr/fr/flagged', 'flag read (A/B)']
		] as const) {
			await fetch(origin + path);
			const second = await fetch(origin + path);
			check(`S5 ${why}: never stored`, freeze_via(second) === '', freeze_via(second) || '(none)');
			check(`S5 ${why}: re-rendered`, ((await renders())[path] ?? 0) === 2);
		}
		// The verdict's OTHER word: refused pages (where the app set no cache-control of its own)
		// are stamped `private, no-store` — per-page proven headers replace blanket CDN rules in
		// both directions. (The setcookie page carries a Set-Cookie, so no shared cache may keep it.)
		const refused = await fetch(origin + '/fr/fr/flagged');
		check(
			'S5: refused page stamped private, no-store',
			refused.headers.get('cache-control') === 'private, no-store',
			refused.headers.get('cache-control') ?? '(none)'
		);

		// ── S6: holes — frozen shell, fresh hole, prerender-grade capability ─────────────────────
		const hole1 = await fetch(origin + '/fr/fr/hole');
		const hole1_html = (await hole1.text()).replace(AMP_ENTITY_G_RE, '&');
		const exp = Number(REGION_ENDPOINT_URL_RE.exec(hole1_html)?.[1] ?? 0);
		check('S6: shell stored', freeze_via(hole1) === 'stored');
		check(
			'S6: hole capability is PRERENDER-GRADE (outlives regionTtl)',
			exp > Date.now() / 1000 + 86400 * 30,
			`exp=${exp}`
		);
		const hole2 = await fetch(origin + '/fr/fr/hole');
		check('S6: second shell is the stored copy', freeze_via(hole2) === 'hit');
		check('S6: shell rendered once', (await renders())['/fr/fr/hole'] === 1);
		// Browser leg: the hole FETCHES FRESH per visit while the shell stays frozen.
		{
			await page.goto(origin + '/fr/fr/hole', { waitUntil: 'networkidle' });
			const serial_a = (
				await page.locator('[data-hole-serial]').textContent({ timeout: 8000 })
			)?.trim();
			await page.goto('about:blank');
			await page.goto(origin + '/fr/fr/hole', { waitUntil: 'networkidle' });
			const serial_b = (
				await page.locator('[data-hole-serial]').textContent({ timeout: 8000 })
			)?.trim();
			check(
				'S6 browser: hole content is fresh per visit',
				!!serial_a && !!serial_b && serial_a !== serial_b,
				`${serial_a} vs ${serial_b}`
			);
			check('S6 browser: shell STILL rendered once', (await renders())['/fr/fr/hole'] === 1);
		}

		// ── S7: stored redirects ──────────────────────────────────────────────────────────────────
		const red1 = await fetch(origin + '/fr/fr/redirect-me', { redirect: 'manual' });
		check(
			'S7: 301 with location',
			red1.status === 301 && red1.headers.get('location') === '/fr/fr/c/home'
		);
		const red2 = await fetch(origin + '/fr/fr/redirect-me', { redirect: 'manual' });
		check('S7: second redirect served from the store', freeze_via(red2) === 'hit');
		check('S7: redirect rendered once', (await renders())['/fr/fr/redirect-me'] === 1);

		// ── S8: action self-evict ─────────────────────────────────────────────────────────────────
		await fetch(origin + '/fr/fr/act');
		const act_warm = await fetch(origin + '/fr/fr/act');
		check('S8: stored before the action', freeze_via(act_warm) === 'hit');
		const post = await fetch(origin + '/fr/fr/act', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
			body: '',
			redirect: 'manual'
		});
		check('S8: action succeeded', post.status < 400, String(post.status));
		const act_after = await fetch(origin + '/fr/fr/act');
		check(
			'S8: the action EVICTED its page (fresh render, fresh tally)',
			TALLY_ONE_RE.test(await act_after.text())
		);
		check('S8: render count grew', (await renders())['/fr/fr/act'] === 2);

		// ── S9: stampede — the single-flight law ──────────────────────────────────────────────────
		const volley = await Promise.all(
			Array.from({ length: 50 }, () => fetch(origin + '/fr/fr/c/stampede'))
		);
		check(
			'S9: all 50 answered 200',
			volley.every((r) => r.status === 200)
		);
		const bodies = await Promise.all(volley.map((r) => r.text()));
		// Served-from-store copies carry the doc marker; the ONE capture response doesn't (by design —
		// live regions read it to self-freshen). Strip before byte-identity comparisons.
		check(
			'S9: all identical bytes (modulo the doc marker joins carry)',
			new Set(bodies.map((b) => b.replace(FREEZE_META_RE, ''))).size === 1
		);
		check(
			'S9: exactly ONE capture response, the rest served copies',
			volley.filter((r) => freeze_via(r) === 'stored').length === 1
		);
		check(
			'S9: ONE render for 50 concurrent colds',
			(await renders())['/fr/fr/c/stampede'] === 1,
			String((await renders())['/fr/fr/c/stampede'])
		);

		// ── S10: csr=true page stores the same (csr-agnostic) ────────────────────────────────────
		const spa1 = await fetch(origin + '/spa');
		check('S10: Kit-booted page', KIT_BOOT_RE.test(await spa1.text()));
		const spa2 = await fetch(origin + '/spa');
		check('S10: stored + served', freeze_via(spa2) === 'hit');
		check('S10: one render', (await renders())['/spa'] === 1);

		// ── S11: failure injection — one edge down never fails a publish ─────────────────────────
		await fetch(akamai!.base + '/__edge/fail', {
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
		check(
			'S11: origin still evicted + re-rendered (v3)',
			(await r5.text()).includes('content of home v3')
		);
		await fetch(akamai!.base + '/__edge/fail', {
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
				akamai!.state().purges.some((p) => p.kind === 'url' && p.value === path)
			);
		}
		const promo1 = await fetch(origin + '/fr/fr/c/home');
		check('S12: consumer re-rendered with the fresh doc', PROMO_TWO_RE.test(await promo1.text()));
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
		// canonical never did — its freeze must survive the doc publish untouched.
		const bystander = await fetch(origin + '/fr/fr/consent');
		check('S12: a non-consumer page was untouched', freeze_via(bystander) === 'hit');

		// ── S13: render:'live' inside a stored page — the self-freshening header ─────────────────
		// The shell stores; the header is a live lake BAKED into the bytes (no fallback flash),
		// hosted by a small island. Served-from-store documents carry the doc marker, so the lake
		// revalidates on FIRST mount: a fresh SERVER render carrying the visitor's cookies, swapped
		// in. Canonical for anonymous, personal for the visitor — on a page that never re-renders.
		const lh1 = await fetch(origin + '/fr/fr/live-header');
		check('S13: shell stored', freeze_via(lh1) === 'stored');
		check(
			'S13: header baked as canonical (guest) in the first bytes',
			(await lh1.text()).includes('Hello, guest')
		);
		const lh2 = await fetch(origin + '/fr/fr/live-header');
		const lh2_html = await lh2.text();
		check(
			'S13: second serve is the stored copy + carries the doc marker',
			freeze_via(lh2) === 'hit' && lh2_html.includes('name="ogygia-freeze"')
		);
		{
			// A cookied visitor: the cookie rides the test's context, on a fresh page.
			await context.addCookies([{ name: 'user', value: 'Puru', url: origin }]);
			const bpage = await context.newPage();
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
			check(
				'S13 browser: shell STILL rendered once',
				(await renders())['/fr/fr/live-header'] === 1
			);
			await bpage.close();
		}

		// ── S14: validators — a revalidation of a stored page costs ZERO body bytes ──────────────
		// The etag/last-modified live on the ENTRY (freeze level, minted at store time), and the
		// handle answers plain-HTTP conditionals — which is exactly what makes an Akamai prefresh
		// (If-Modified-Since) or a browser reload against a stored page a 304, not a re-send.
		const v1 = await fetch(origin + '/fr/fr/c/home');
		const etag = v1.headers.get('etag');
		const last_modified = v1.headers.get('last-modified');
		check(
			'S14: stored page carries etag + last-modified',
			!!etag && !!last_modified,
			`${etag} / ${last_modified}`
		);
		const v2 = await fetch(origin + '/fr/fr/c/home', { headers: { 'if-none-match': etag ?? '' } });
		check('S14: If-None-Match answers 304', v2.status === 304, String(v2.status));
		check('S14: 304 body is EMPTY', (await v2.text()).length === 0);
		check('S14: 304 keeps the validators', v2.headers.get('etag') === etag);
		const v3 = await fetch(origin + '/fr/fr/c/home', {
			headers: { 'if-modified-since': last_modified ?? '' }
		});
		check(
			'S14: If-Modified-Since answers 304 (the Akamai prefresh shape)',
			v3.status === 304,
			String(v3.status)
		);
		const v4 = await fetch(origin + '/fr/fr/c/home', { headers: { 'if-none-match': '"nope"' } });
		check(
			'S14: a stale validator gets the full 200',
			v4.status === 200 && (await v4.text()).length > 0
		);

		// ── S15: SERVE-TIME STITCHING — personalized in the FIRST response, shell still frozen ───
		// A `stitch: 'serve'` deferred hole: the shell stores once; EVERY serve renders the hole
		// server-side with the visitor's cookies and splices it into the stored bytes. The money
		// assertion: a cookied visitor's RAW response body carries their name — view-source
		// personalization on a page whose render counter never moves.
		const st1 = await fetch(origin + '/fr/fr/stitched');
		const st1_html = await st1.text();
		check('S15: shell stored on first serve', freeze_via(st1) === 'stored');
		check(
			'S15: anon serve is stitched (no fallback in the bytes)',
			st1_html.includes('data-og-stitched') &&
				st1_html.includes('Hello, guest') &&
				!st1_html.includes('data-stitch-fallback')
		);
		check(
			'S15: stitched page is edge-bypassed',
			st1.headers.get('cache-control') === 'private, no-store'
		);
		check('S15: stitched page mints NO validators', st1.headers.get('etag') === null);
		const st2 = await fetch(origin + '/fr/fr/stitched', { headers: { cookie: 'user=Puru' } });
		const st2_html = await st2.text();
		check('S15: second serve is the stored shell', freeze_via(st2) === 'hit');
		check(
			'S15: THE MONEY SHOT — visitor name in the RAW first response',
			st2_html.includes('Hello, Puru'),
			st2_html.includes('Hello, guest') ? 'still guest' : '(name absent)'
		);
		const st3 = await fetch(origin + '/fr/fr/stitched');
		check(
			'S15: next anonymous visitor gets guest bytes again (per-visitor serves)',
			(await st3.text()).includes('Hello, guest')
		);
		check(
			'S15: shell rendered exactly ONCE through all of it',
			(await renders())['/fr/fr/stitched'] === 1,
			String((await renders())['/fr/fr/stitched'])
		);

		// ── S16: PER-ROUTE OPT-OUT — `export const freeze = false` on a PURE page ──────────────
		// The optout page reads nothing per-visitor, so under `freeze: true` (default on) it would
		// normally store. The route file carries `export const freeze = false`, which ogygia strips
		// before Kit (the fixture built at all = the strip works) and reads into the opt-in route set.
		// The handle must therefore never take the freeze path: no store, no `x-ogygia-freeze`
		// header, a plain per-request render on every hit.
		const oo1 = await fetch(origin + '/fr/fr/optout');
		check(
			'S16 opt-out: pure page is NOT stored (no freeze header)',
			freeze_via(oo1) === '',
			freeze_via(oo1) || '(none)'
		);
		check(
			'S16 opt-out: page still renders correctly',
			(await oo1.text()).includes('pure but opted out')
		);
		const oo2 = await fetch(origin + '/fr/fr/optout');
		check(
			'S16 opt-out: second hit is ALSO per-request (never a stored hit)',
			freeze_via(oo2) === '',
			freeze_via(oo2) || '(none)'
		);

		// ── S17: PROGRAMMATIC ROUTES — `page(C, { freeze })` under `sequence(ogygiaHandle(), app.handle)`
		// Kit's file router never claims /r/*, so `event.route.id` is null there and the handle asks
		// the mounted table. The layout-level opt-in (`layout('r', …, { freeze: true })`) reaches
		// /r/frozen; the page-level `freeze: false` on /r/off overrides it; /r/plain declares nothing
		// anywhere and follows the config default (on in this fixture).
		const rf1 = await fetch(origin + '/r/frozen');
		check(
			'S17 router: layout opt-in → stored',
			freeze_via(rf1) === 'stored',
			freeze_via(rf1) || '(none)'
		);
		check('S17 router: the table rendered it', (await rf1.text()).includes('r-frozen'));
		const rf2 = await fetch(origin + '/r/frozen');
		check(
			'S17 router: second hit served from the store',
			freeze_via(rf2) === 'hit',
			freeze_via(rf2) || '(none)'
		);
		const ro1 = await fetch(origin + '/r/off');
		const ro2 = await fetch(origin + '/r/off');
		check(
			'S17 router: page-level opt-out overrides its layout (never stored)',
			freeze_via(ro1) === '' && freeze_via(ro2) === '',
			`${freeze_via(ro1) || '(none)'} / ${freeze_via(ro2) || '(none)'}`
		);
		check(
			'S17 router: the opted-out page still renders',
			(await ro2.text()).includes('pure but opted out')
		);
		const rp1 = await fetch(origin + '/r/plain');
		const rp2 = await fetch(origin + '/r/plain');
		check(
			'S17 router: undeclared follows the config default (on)',
			freeze_via(rp1) === 'stored' && freeze_via(rp2) === 'hit',
			`${freeze_via(rp1) || '(none)'} / ${freeze_via(rp2) || '(none)'}`
		);

		// ── S18: EDGE STITCHING (ESI) — the shell stays edge-cacheable, the hole becomes an include
		// `stitch: 'edge'` on a deferred hole: the capture rewrites the hole into
		// `<esi:remove>…</esi:remove><esi:include src="<signed capability>"/>` and stamps
		// `Surrogate-Control: content="ESI/1.0"`; the entry keeps public s-maxage + validators, so an
		// ESI CDN serves the shell from cache and fetches only the include. The edge's leg is
		// simulated here: the include src fetched straight from origin with a visitor cookie must
		// answer the PERSONAL header the CDN would splice in.
		const es1 = await fetch(origin + '/fr/fr/esi');
		const es1_html = await es1.text();
		check('S18 esi: shell stored on first serve', freeze_via(es1) === 'stored');
		check(
			'S18 esi: page stays EDGE-CACHEABLE (public, s-maxage)',
			(es1.headers.get('cache-control') ?? '').startsWith('public, s-maxage='),
			es1.headers.get('cache-control') ?? '(none)'
		);
		check(
			'S18 esi: Surrogate-Control announces ESI',
			es1.headers.get('surrogate-control') === 'content="ESI/1.0"',
			es1.headers.get('surrogate-control') ?? '(none)'
		);
		check('S18 esi: validators minted over the rewritten bytes', es1.headers.get('etag') !== null);
		check(
			'S18 esi: hole wrapped in esi:remove and followed by esi:include',
			es1_html.includes('<esi:remove><ogygia-region') &&
				es1_html.includes('</esi:remove><esi:include src="')
		);
		check(
			'S18 esi: fallback survives inside the wrapper (the non-ESI degrade path)',
			es1_html.includes('data-stitch-fallback')
		);
		const es2 = await fetch(origin + '/fr/fr/esi', { headers: { cookie: 'user=Puru' } });
		const es2_html = await es2.text();
		check(
			'S18 esi: second serve is a plain store HIT (no origin re-stitch)',
			freeze_via(es2) === 'hit'
		);
		check(
			'S18 esi: a cookied visitor gets the SAME shell bytes (the edge personalizes, not origin)',
			!es2_html.includes('Hello, Puru') && es2_html.includes('<esi:include')
		);
		const inc_at = es1_html.indexOf('<esi:include src="');
		const src_raw =
			inc_at === -1 ? '' : es1_html.slice(inc_at + 18, es1_html.indexOf('"', inc_at + 18));
		const src = src_raw.split('&amp;').join('&');
		check(
			'S18 esi: the include src is the hole’s signed capability',
			src.includes('/__ogygia__?') && src.includes('sig='),
			src.slice(0, 60) || '(none)'
		);
		const inc = await fetch(new URL(src, origin + '/fr/fr/esi'), {
			headers: { cookie: 'user=Puru' }
		});
		const inc_html = await inc.text();
		check(
			'S18 esi: the include renders the PERSONAL header for the edge to splice',
			inc.status === 200 && inc_html.includes('Hello, Puru'),
			`${inc.status} ${inc_html.includes('Hello, guest') ? 'guest' : inc_html.slice(0, 60)}`
		);
		check(
			'S18 esi: shell rendered exactly ONCE through all of it',
			(await renders())['/fr/fr/esi'] === 1,
			String((await renders())['/fr/fr/esi'])
		);

		// ── S19: ESI THROUGH THE EDGE — the akamai emulator ASSEMBLES, cloudfront passes through ──
		// The akamai personality processes ESI like the real edge: the shell is stored RAW, and on
		// every serve (miss or hit) it strips <esi:remove>, fetches each <esi:include src> from
		// origin WITH THE VIEWER'S COOKIE, and splices. So the second, cookied request is an edge
		// HIT for the shell AND carries the visitor's name — origin rendered the shell once and only
		// ever renders the hole. The cloudfront personality (no ESI) passes the tags through: that is
		// the degrade path, where the client fetches the hole.
		const ee1 = await fetch(edge + '/fr/fr/esi');
		const ee1_html = await ee1.text();
		check(
			'S19 esi@edge: first edge fetch is a miss that got assembled',
			ee1.headers.get('x-edge-akamai') === 'miss' &&
				ee1.headers.get('x-edge-akamai-esi') === 'assembled',
			`${ee1.headers.get('x-edge-akamai')} / ${ee1.headers.get('x-edge-akamai-esi')}`
		);
		check('S19 esi@edge: no esi tags reach the browser', !ee1_html.includes('<esi:'));
		check('S19 esi@edge: anonymous include = guest header', ee1_html.includes('Hello, guest'));
		const ee2 = await fetch(edge + '/fr/fr/esi', { headers: { cookie: 'user=Puru' } });
		const ee2_html = await ee2.text();
		check(
			'S19 esi@edge: THE MONEY SHOT — cookied request is an edge HIT for the shell…',
			ee2.headers.get('x-edge-akamai') === 'hit',
			ee2.headers.get('x-edge-akamai') ?? '(none)'
		);
		check(
			'S19 esi@edge: …AND carries the visitor’s name (the include was fetched with the cookie)',
			ee2_html.includes('Hello, Puru') && !ee2_html.includes('<esi:'),
			ee2_html.includes('Hello, guest') ? 'guest' : '(name absent)'
		);
		check(
			'S19 esi@edge: origin rendered the shell exactly once — the edge did the personalizing',
			(await renders())['/fr/fr/esi'] === 1,
			String((await renders())['/fr/fr/esi'])
		);
		const edge_state = (await (await fetch(edge + '/__edge/state')).json()) as { esi: number };
		check(
			'S19 esi@edge: the edge fetched one include per serve',
			edge_state.esi >= 2,
			String(edge_state.esi)
		);
		const cfr = await fetch(cf!.base + '/fr/fr/esi', { headers: { cookie: 'user=Puru' } });
		const cfr_html = await cfr.text();
		check(
			'S19 esi@edge: a NON-ESI edge (cloudfront) passes the tags through — the degrade path',
			cfr_html.includes('<esi:include') && cfr_html.includes('data-stitch-fallback')
		);
	});
});
