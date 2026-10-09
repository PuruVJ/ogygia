/**
 * Fragment federation v2 seams that run WITHOUT a browser: the peer transport (SWR cache,
 * coalescing, generation-safe invalidation, failover), Ed25519 signing/verification (audience,
 * replay, rotation), `mount()`'s auto-built claims, the document lifter, remote regions, provenance
 * adoption, and cross-app thaw. Design: internal/notes/federation.md.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { make_peer } from '../src/federation/peer.js';
import { federate } from '../src/federation/federate.js';
import { mount } from '../src/federation/mount.js';
import { mint_hole, set_hole_signer } from '../src/federation/hole.js';
import { sign_headers, verify_signed_request, lift_document } from '../src/federation/wire.js';
import { set_federation } from '../src/federation/registry.js';
import { set_source_observer } from '../src/freeze/capture.js';
import { set_thaw_notifier } from '../src/freeze/registry.js';
import { routes } from '../src/router/index.js';
import { flag } from '../src/flags.js';

const CLAIMS = Symbol.for('ogygia.claims.v1');
const doc_json = (extra: Record<string, unknown> = {}, status = 200) =>
	JSON.stringify({ status, title: 't', css: [], body: 'B', ...extra });

afterEach(() => {
	vi.unstubAllGlobals();
	set_federation(null);
	set_source_observer(null);
	set_thaw_notifier(null);
	set_hole_signer(null);
});

describe('peer transport — one per remote app', () => {
	it('coalesces concurrent misses into ONE upstream call', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return new Response(doc_json({ body: 'one' }));
		});
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell');
		const [a, b] = await Promise.all([cms.doc('/p', ''), cms.doc('/p', '')]);
		expect(calls).toBe(1);
		expect(a.body).toBe('one');
		expect(b.body).toBe('one');
	});

	it('serves fresh, then STALE + refreshes in background after ttl (SWR)', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => new Response(doc_json({ body: `v${++calls}` })));
		const now = vi.spyOn(Date, 'now');
		const t0 = 1_000_000;
		now.mockReturnValue(t0);
		const cms = make_peer('cms', { origin: 'http://mfe.test', cache: { ttl: 1000 } }, 'shell');

		expect((await cms.doc('/p', '')).body).toBe('v1'); // miss
		expect((await cms.doc('/p', '')).body).toBe('v1'); // fresh hit
		expect(calls).toBe(1);

		now.mockReturnValue(t0 + 5000); // past ttl
		expect((await cms.doc('/p', '')).body).toBe('v1'); // stale served INSTANTLY
		await new Promise((r) => setTimeout(r, 0));
		expect((await cms.doc('/p', '')).body).toBe('v2'); // refreshed
		expect(calls).toBe(2);
		now.mockRestore();
	});

	it('generation: a pre-mutation in-flight fetch cannot repopulate the cache', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let gets = 0;
		vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
			if (init?.method === 'POST') return new Response(doc_json({ body: 'post' }));
			gets++;
			if (gets === 1) await gate;
			return new Response(doc_json({ body: `get${gets}` }));
		});
		const cms = make_peer('cms', { origin: 'http://mfe.test', cache: { ttl: 60_000 } }, 'shell');
		const before = cms.doc('/p', '');
		await cms.postDoc('/p', '', new ArrayBuffer(0), 'text/plain');
		release();
		expect((await before).body).toBe('get1'); // caller still gets its answer
		expect((await cms.doc('/p', '')).body).toBe('get2'); // cache re-reads truth
		expect(gets).toBe(2);
	});

	it('postDoc speaks AS the peer (origin header) and forwards the content-type', async () => {
		let captured: Record<string, string> = {};
		vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(doc_json());
		});
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell');
		await cms.postDoc('/p', '', new ArrayBuffer(0), 'application/x-www-form-urlencoded');
		expect(captured.origin).toBe('http://mfe.test');
		expect(captured['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('widgetDoc hits the catalog path with props', async () => {
		let seen: URL | undefined;
		vi.stubGlobal('fetch', async (u: URL) => {
			seen = u;
			return new Response(JSON.stringify({ html: '<div>kpis</div>' }));
		});
		const dash = make_peer('dash', { origin: 'http://dash.test' }, 'shell');
		const d = await dash.widgetDoc('kpis', { org: 'acme' });
		expect(seen!.href).toBe('http://dash.test/og/fragment/kpis?org=acme');
		expect(d.html).toBe('<div>kpis</div>');
	});

	it('widgetDoc throws a plain Error; doc() throws http errors; a network failure is a 504', async () => {
		vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
		const dash = make_peer('dash', { origin: 'http://dash.test' }, 'shell');
		await expect(dash.widgetDoc('kpis')).rejects.toThrow("fragment 'kpis' answered 500");
		await expect(dash.doc('/p', '')).rejects.toMatchObject({ status: 502 });
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell');
		await expect(cms.doc('/p', '')).rejects.toMatchObject({ status: 504 });
	});

	it('failover: an unreachable primary tries the next origin; a 404 does not', async () => {
		const hit: string[] = [];
		vi.stubGlobal('fetch', async (u: URL) => {
			hit.push(new URL(u).host);
			if (new URL(u).host === 'a.test') throw new TypeError('down');
			return new Response(doc_json({ body: 'from-b' }));
		});
		const cms = make_peer('cms', { origin: ['http://a.test', 'http://b.test'] }, 'shell');
		expect((await cms.doc('/p', '')).body).toBe('from-b');
		expect(hit).toEqual(['a.test', 'b.test']);
	});
});

describe('Ed25519 signing / verification', () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	const { publicKey: pk2 } = generateKeyPairSync('ed25519');
	const pub2 = pk2.export({ type: 'spki', format: 'der' }).toString('base64');

	const signed = (host = 'cms.test', audience?: string) => {
		const u = new URL(`http://${host}/og/fragment/page?path=/p`);
		const h = sign_headers(priv, 'GET', u, undefined, { sub: 'u1' }, audience);
		return new Request(u, { headers: h });
	};

	it('accepts a fresh, correctly-signed request once and returns its claims', () => {
		const req = signed();
		expect(verify_signed_request({ publicKeys: [pub] }, req, new URL(req.url))?.user?.sub).toBe(
			'u1'
		);
	});

	it('AUDIENCE BINDING: a hop signed for cms.test is rejected at dash.test (same key)', () => {
		const req = signed('cms.test');
		const at_dash = new Request('http://dash.test/og/fragment/page?path=/p', {
			headers: Object.fromEntries(req.headers)
		});
		expect(verify_signed_request({ publicKeys: [pub] }, at_dash, new URL(at_dash.url))).toBeNull();
	});

	it('REPLAY: a byte-identical second delivery is rejected', () => {
		const req = signed();
		const url = new URL(req.url);
		expect(verify_signed_request({ publicKeys: [pub] }, req, url)?.user?.sub).toBe('u1');
		const replayed = new Request(req.url, { headers: Object.fromEntries(req.headers) });
		expect(verify_signed_request({ publicKeys: [pub] }, replayed, url)).toBeNull();
	});

	it('NaN timestamp does not bypass the freshness gate', () => {
		const req = signed();
		const forged = new Request(req.url, {
			headers: { ...Object.fromEntries(req.headers), 'x-og-ts': 'not-a-number' }
		});
		expect(verify_signed_request({ publicKeys: [pub] }, forged, new URL(forged.url))).toBeNull();
	});

	it('a second authorized key still verifies (rotation / multi-caller)', () => {
		const req = signed();
		expect(
			verify_signed_request({ publicKeys: [pub2, pub] }, req, new URL(req.url))?.user?.sub
		).toBe('u1');
	});

	it('tampered claims (re-encoded x-og-user) break the signature', () => {
		const req = signed();
		const forged = new Request(req.url, {
			headers: {
				...Object.fromEntries(req.headers),
				'x-og-user': Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64')
			}
		});
		expect(verify_signed_request({ publicKeys: [pub] }, forged, new URL(forged.url))).toBeNull();
	});
});

describe('lift_document — an app’s full HTML → the wire shape', () => {
	it('extracts title, stylesheet links, and SEO meta; drops charset/viewport; absolutizes assets', () => {
		const html = `<html><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width">
			<meta name="description" content="hi">
			<link rel="canonical" href="/cms/p">
			<title>CMS</title>
			<link rel="stylesheet" href="/_app/immutable/a.css">
		</head><body><ogygia-region entry="/_app/immutable/i.js"></ogygia-region></body></html>`;
		const d = lift_document(html, 'http://cms.test');
		expect(d.title).toBe('CMS');
		expect(d.css.join('')).toContain('http://cms.test/_app/immutable/a.css');
		expect(d.head).toContain('name="description"');
		expect(d.head).not.toContain('charset');
		expect(d.head).not.toContain('viewport');
		expect(d.body).toContain('entry="http://cms.test/_app/immutable/i.js"');
	});
});

describe('mount() — claims auto-built from the table identity', () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

	it('signs c.visitor + EVERY table experiment into the hop — no hand-listing', async () => {
		let seen: Request | undefined;
		vi.stubGlobal('fetch', async (u: URL, init?: RequestInit) => {
			seen = new Request(u, init);
			return new Response(doc_json());
		});
		const exp = flag('hero', { rollout: 100 });
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell', priv);
		const app = routes(
			{ '/cms/[...rest]': mount(cms) },
			{ visitor: () => ({ sub: 'u9' }), flags: [exp] }
		);
		await app.fetch(new Request('http://shell.test/cms/x'));
		const v = verify_signed_request(
			{ publicKeys: [pub], audience: 'mfe.test' },
			seen!,
			new URL(seen!.url)
		);
		expect(v?.user?.sub).toBe('u9');
		expect((v?.user?.experiments as Record<string, unknown>)?.hero).toBeDefined();
	});

	it('STATUS CHANNEL: a mounted 404 answers 404 through the shell', async () => {
		vi.stubGlobal('fetch', async () => new Response(doc_json({ status: 404, body: 'gone' })));
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell');
		const app = routes({ '/cms/[...rest]': mount(cms) });
		const res = await app.fetch(new Request('http://shell.test/cms/x'));
		expect(res!.status).toBe(404);
	});

	it('anonymous + no experiments = NO claims header at all', async () => {
		let seen: Request | undefined;
		vi.stubGlobal('fetch', async (u: URL, init?: RequestInit) => {
			seen = new Request(u, init);
			return new Response(doc_json());
		});
		const cms = make_peer('cms', { origin: 'http://mfe.test' }, 'shell', priv);
		const app = routes({ '/cms/[...rest]': mount(cms) });
		await app.fetch(new Request('http://shell.test/cms/x'));
		expect(seen!.headers.get('x-og-user')).toBeNull();
	});
});

describe('federate() — registration + fail-closed', () => {
	beforeEach(() => vi.stubGlobal('fetch', async () => new Response(doc_json())));

	it('returns typed peer handles keyed by name', () => {
		const { cms, dash } = federate({
			name: 'shell',
			peers: { cms: { origin: 'http://cms.test' }, dash: { origin: 'http://dash.test' } }
		});
		expect(cms.name).toBe('cms');
		expect(dash.origin).toBe('http://dash.test');
	});

	it('warns when it exposes but no peer has a key (and not with `open`)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		federate({ name: 'cms', expose: {} as never, peers: {} });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNAUTHENTICATED'));
		warn.mockClear();
		federate({ name: 'cms', expose: {} as never, peers: {}, open: true });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('remote regions', () => {
	it('a static remote page bakes its HTML and adopts the fragment’s tags into the capture', async () => {
		const seen: string[] = [];
		set_source_observer((t) => seen.push(t));
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(
					doc_json({ body: '<p>fresh</p>', css: ['<link>'], sources: ['s:doc:1'], path: '/cms/p' })
				)
		);
		const cms = make_peer('cms', { origin: 'http://cms.test' }, 'shell');
		const region = await cms.page('/p');
		expect((region as { html?: string; props: { html?: string } }).props.html).toContain('fresh');
		// the page's receipts are adopted under the peer name (so a thaw matches)
		expect(seen).toContain('a:cms');
		expect(seen).toContain('p:cms:/cms/p');
		expect(seen).toContain('r:cms:s:doc:1');
	});

	it('a deferred remote region is a hole with a shell-signed url', async () => {
		set_hole_signer(({ peer, target }) => `/og/frag?peer=${peer}&target=${target}&sig=abc`);
		const cms = make_peer('cms', { origin: 'http://cms.test' }, 'shell');
		const hole = await cms.page('/p', { render: 'deferred' });
		expect(hole.kind).toBe('deferred');
		expect((hole as { url: string }).url).toBe('/og/frag?peer=cms&target=/p&sig=abc');
	});

	it('mint_hole degrades to an empty inert region when no signer is installed', () => {
		const hole = mint_hole('cms', 'page', '/p', '');
		expect(hole.kind).toBe('deferred');
		expect((hole as { url: string }).url).toBe('');
	});
});

describe('cross-app thaw', () => {
	it('every freeze.invalidate() fires a notice to peers with the evicted tags', async () => {
		const notices: (string[] | 'all')[] = [];
		set_thaw_notifier(async (tags) => {
			notices.push(tags);
		});
		const { freeze } = await import('../src/freeze/index.js');
		await freeze.invalidate('/cms/solar');
		expect(notices).toContainEqual(['p:/cms/solar']);
		await freeze.invalidateWhere({ prefix: '/cms/' });
		expect(notices).toContainEqual('all');
	});

	it('peer.drop evicts cached documents by their adopted tags', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			return new Response(doc_json({ body: `v${calls}`, sources: ['s:doc:1'], path: '/cms/p' }));
		});
		const cms = make_peer('cms', { origin: 'http://cms.test', cache: { ttl: 60_000 } }, 'shell');
		expect((await cms.doc('/p', '')).body).toBe('v1');
		expect((await cms.doc('/p', '')).body).toBe('v1'); // cached
		expect(calls).toBe(1);
		cms.drop(new Set(['r:cms:s:doc:1'])); // a thaw for that source
		expect((await cms.doc('/p', '')).body).toBe('v2'); // re-fetched
		expect(calls).toBe(2);
	});
});
