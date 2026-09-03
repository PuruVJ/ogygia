// FRAGMENT FEDERATION v2 — end to end, three real dev servers (shell + cms + dash) from
// examples/mfe with throwaway Ed25519 keys. Covers: `mount()` a whole remote app, a remote widget
// as a REGION (static baked + deferred hole), the signed endpoint gate, the unsigned __catalog
// manifest, and cross-app THAW notices over HTTP. Design: internal/notes/federation.md.
import { createPrivateKey, createHash, randomBytes, sign as ed_sign } from 'node:crypto';
import { test, expect } from './fixtures/mfe.ts';

/** Sign a request exactly like `federation/wire.ts` `sign_headers` (ts.METHOD.pathq.bhash.claims.aud.nonce). */
function sign_headers(
	priv_b64: string,
	method: string,
	u: URL,
	body?: ArrayBuffer
): Record<string, string> {
	const key = createPrivateKey({
		key: Buffer.from(priv_b64, 'base64'),
		format: 'der',
		type: 'pkcs8'
	});
	const ts = String(Date.now());
	const nonce = randomBytes(8).toString('hex');
	const bhash = createHash('sha256')
		.update(body ? new Uint8Array(body) : new Uint8Array(0))
		.digest('base64');
	const msg = `${ts}.${method.toUpperCase()}.${u.pathname + u.search}.${bhash}..${u.host}.${nonce}`;
	const sig = ed_sign(null, Buffer.from(msg), key).toString('base64');
	return { 'x-og-ts': ts, 'x-og-n': nonce, 'x-og-sig': sig };
}

test.describe('fragment federation v2', () => {
	test('mount(): the shell renders the whole cms app under /cms/', async ({ mfe }) => {
		const html = await (await fetch(mfe.origin('shell') + '/cms/')).text();
		expect(html, 'the cms home (its own route table) rendered under the shell').toContain(
			'cms-home'
		);
		expect(html).toContain('Latest posts');
	});

	test('a remote widget as a STATIC region is baked into the shell home (freezable)', async ({
		mfe
	}) => {
		const res = await fetch(mfe.origin('shell') + '/');
		const html = await res.text();
		expect(html, 'dash rendered its kpis on the dash server, baked into the shell SSR').toContain(
			'Dashboard · acme'
		);
		expect(html).toContain('data-testid="dash-fragment"');
		// the anonymous static render is eligible to freeze (dev teaches with the verdict header)
		expect(res.headers.get('x-ogygia-freeze')).toBe('would-store');
	});

	test('a DEFERRED remote widget is a shell-signed hole the browser fetches', async ({ mfe }) => {
		const html = await (await fetch(mfe.origin('shell') + '/')).text();
		const m = html.match(/\/og\/frag\?[^"]+/);
		expect(m, 'the deferred region emitted an /og/frag hole endpoint').toBeTruthy();
		const hole = m![0].replace(/&amp;/g, '&');
		expect(hole).toContain('peer=dash');
		// fetching the hole through the SHELL returns dash's kpis HTML (claims derived server-side)
		const frag = await (await fetch(mfe.origin('shell') + hole)).text();
		expect(frag, 'the hole rendered the widget for the other org').toContain(
			'Dashboard · live-inc'
		);
	});

	test('the fragment endpoints REQUIRE a signature (401 without one)', async ({ mfe }) => {
		const cms = await fetch(mfe.origin('cms') + '/og/fragment/page?path=/');
		expect(cms.status, 'cms expose is signature-gated').toBe(401);
		const dash = await fetch(mfe.origin('dash') + '/og/fragment/kpis?org=acme');
		expect(dash.status, 'dash widgets are signature-gated').toBe(401);
	});

	test('the __catalog manifest is unsigned inventory (names + prop names)', async ({ mfe }) => {
		const res = await fetch(mfe.origin('dash') + '/og/fragment/__catalog');
		expect(res.status).toBe(200);
		const cat = (await res.json()) as {
			names: string[];
			widgets: Record<string, { props: string[] }>;
		};
		expect(cat.names).toContain('kpis');
		expect(cat.widgets.kpis.props).toContain('org');
	});

	test('cross-app THAW: a signed notice AS a peer is accepted; unsigned is 401', async ({
		mfe
	}) => {
		const u = new URL(mfe.origin('shell') + '/og/thaw');
		const body = Buffer.from(
			JSON.stringify({ id: 'e2e-' + Date.now(), hop: 0, tags: ['p:/kpis'] })
		);
		const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;

		// signed AS the dash team (the shell holds dash's public key as a peer)
		const signed = await fetch(u, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...sign_headers(mfe.keys.dash.priv, 'POST', u, ab)
			},
			body: ab
		});
		expect(signed.status, 'the shell verified the dash-signed notice').toBe(200);

		// unsigned — refused before any work
		const unsigned = await fetch(u, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: ab
		});
		expect(unsigned.status, 'an unsigned thaw notice is rejected').toBe(401);

		// a forged notice signed with the WRONG key (the shell's own, which is not a peer of itself)
		const forged = await fetch(u, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...sign_headers(mfe.keys.shell.priv, 'POST', u, ab)
			},
			body: ab
		});
		expect(forged.status, 'a notice from a non-peer key is rejected').toBe(401);
	});
});
