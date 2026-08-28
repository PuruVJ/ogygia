/**
 * Fragment federation seams that run WITHOUT a browser: the per-MFE client() transport
 * (coalescing, SWR cache, generation-safe invalidation, widget catalog fetches) and the identity
 * spine — routes({ visitor, experiments }) → c.visitor → mount()'s auto-built claims riding the
 * Ed25519 signature. Whole-app mounting/waking is covered by the POC gauntlet + e2e.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { routes, client, mount, kitMount, proxy, expose, catalog, sign_headers, verify_fragment_request } from '../src/router/index.js';
import { experiment } from '../src/experiment.js';

const CLAIMS = Symbol.for('ogygia.claims.v1');

const doc_json = (body = 'B', status = 200) =>
	JSON.stringify({ status, title: 't', css: [], body });

afterEach(() => vi.unstubAllGlobals());

describe('routes({ visitor }) — the ONE identity', () => {
	const make = (resolver: (c: { request: Request }) => { sub?: string } | undefined) => {
		let calls = 0;
		const app = routes(
			{
				'/me': {
					GET: (c) => c.json({ first: c.visitor ?? null, second: c.visitor ?? null })
				},
				'/plain': { GET: (c) => c.json({ ok: true }) }
			},
			{
				visitor: (c) => {
					calls++;
					return resolver(c);
				}
			}
		);
		return { app, calls: () => calls };
	};

	it('resolves lazily, memoizes per request, and reaches handlers as c.visitor', async () => {
		const { app, calls } = make((c) => {
			const sub = c.request.headers.get('x-session');
			return sub ? { sub } : undefined;
		});
		const res = await app.fetch(
			new Request('http://x/me', { headers: { 'x-session': 'u1' } })
		);
		const { first, second } = await res!.json();
		expect(first).toEqual({ sub: 'u1' });
		expect(second).toEqual({ sub: 'u1' }); // same derivation, read twice
		expect(calls()).toBe(1); // …but RESOLVED once
	});

	it('handlers that never read c.visitor never pay for it', async () => {
		const { app, calls } = make(() => ({ sub: 'u1' }));
		await app.fetch(new Request('http://x/plain'));
		expect(calls()).toBe(0);
	});

	it('signature-bound claims from an upstream shell WIN over the resolver', async () => {
		const { app, calls } = make(() => ({ sub: 'from-config' }));
		const req = new Request('http://x/me');
		// what expose() attaches after Ed25519 verification — proof beats config
		(req as unknown as Record<symbol, unknown>)[CLAIMS] = { sub: 'from-signature' };
		const res = await app.fetch(req);
		expect((await res!.json()).first).toEqual({ sub: 'from-signature' });
		expect(calls()).toBe(0); // resolver never consulted
	});
});

describe('client() — one transport per MFE', () => {
	it('coalesces concurrent misses into ONE upstream call', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return new Response(doc_json('one'));
		});
		const cms = client('http://mfe.test');
		const [a, b] = await Promise.all([cms.doc('/p', ''), cms.doc('/p', '')]);
		expect(calls).toBe(1);
		expect(a.body).toBe('one');
		expect(b.body).toBe('one');
	});

	it('serves fresh from cache, serves STALE + refreshes in background after ttl (SWR)', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => new Response(doc_json(`v${++calls}`)));
		const now = vi.spyOn(Date, 'now');
		const t0 = 1_000_000;
		now.mockReturnValue(t0);
		const cms = client('http://mfe.test', { cache: { ttl: 1000 } });

		expect((await cms.doc('/p', '')).body).toBe('v1'); // miss → upstream
		expect((await cms.doc('/p', '')).body).toBe('v1'); // fresh hit, no call
		expect(calls).toBe(1);

		now.mockReturnValue(t0 + 5000); // past ttl
		expect((await cms.doc('/p', '')).body).toBe('v1'); // stale served INSTANTLY
		await new Promise((r) => setTimeout(r, 0)); // let the background refresh land
		expect((await cms.doc('/p', '')).body).toBe('v2'); // refreshed
		expect(calls).toBe(2);
		now.mockRestore();
	});

	it('generation: an in-flight pre-mutation fetch cannot repopulate the cache', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let gets = 0;
		vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
			if (init?.method === 'POST') return new Response(doc_json('post-answer'));
			gets++;
			if (gets === 1) await gate; // the pre-mutation GET hangs until after the POST
			return new Response(doc_json(`get${gets}`));
		});
		const cms = client('http://mfe.test', { cache: { ttl: 60_000 } });

		const before = cms.doc('/p', ''); // starts BEFORE the mutation…
		await cms.postDoc('/p', '', new ArrayBuffer(0), 'text/plain'); // …which invalidates
		release();
		expect((await before).body).toBe('get1'); // the caller still gets its answer…
		expect((await cms.doc('/p', '')).body).toBe('get2'); // …but the cache re-reads truth
		expect(gets).toBe(2);
	});

	it('postDoc speaks AS the MFE (origin header) and forwards the content-type', async () => {
		let captured: Record<string, string> = {};
		vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(doc_json());
		});
		const cms = client('http://mfe.test');
		await cms.postDoc('/p', '', new ArrayBuffer(0), 'application/x-www-form-urlencoded');
		expect(captured.origin).toBe('http://mfe.test');
		expect(captured['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('widget() hits the catalog path with props and returns the document', async () => {
		let seen: URL | undefined;
		vi.stubGlobal('fetch', async (u: URL) => {
			seen = u;
			return new Response(JSON.stringify({ html: '<div>kpis</div>' }));
		});
		const dash = client('http://dash.test');
		const doc = await dash.widget('kpis', { org: 'acme' });
		expect(seen!.href).toBe('http://dash.test/og/fragment/kpis?org=acme');
		expect(doc.html).toBe('<div>kpis</div>');
	});

	it('widget() throws a PLAIN Error (caller degrades), doc() throws http errors', async () => {
		vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
		const dash = client('http://dash.test');
		await expect(dash.widget('kpis')).rejects.toThrow("fragment 'kpis' answered 500");
		await expect(dash.doc('/p', '')).rejects.toMatchObject({ status: 502 });
	});

	it('doc() turns network failure into a 504 boundary error', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		const cms = client('http://mfe.test');
		await expect(cms.doc('/p', '')).rejects.toMatchObject({ status: 504 });
	});
});

describe('mount() — claims auto-built from the table identity', () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub_b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv_b64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	const mode = experiment('mode', { variants: ['static', 'hydrated'], split: { hydrated: 100 } });

	const capture_hop = () => {
		const seen: { url?: URL; headers?: Record<string, string> } = {};
		vi.stubGlobal('fetch', async (u: URL, init?: RequestInit) => {
			seen.url = new URL(u);
			seen.headers = init?.headers as Record<string, string>;
			return new Response(doc_json());
		});
		return seen;
	};

	const decode_claims = (headers: Record<string, string>) =>
		JSON.parse(Buffer.from(headers['x-og-user'], 'base64').toString()) as {
			sub?: string;
			experiments?: Record<string, string>;
		};

	it('signs c.visitor + EVERY table experiment into the hop — no hand-listing', async () => {
		const seen = capture_hop();
		const app = routes(
			{ '/cms/[...rest]': mount('http://mfe.test', { sign: { privateKey: priv_b64 } }) },
			{ visitor: () => ({ sub: 'puru', roles: ['admin'] }), experiments: [mode] }
		);
		const res = await app.fetch(new Request('http://shell/cms/hello'));
		expect(res!.status).toBe(200);
		// the wire document renders through the pure-HTML region: body verbatim, title in the
		// DOCUMENT head (Mounted.svelte is gone — this is the region-resolver page)
		const html = await res!.text();
		expect(html).toContain('B'); // doc body
		expect(html).toContain('<title>t</title>'); // doc title, document head
		const claims = decode_claims(seen.headers!);
		expect(claims.sub).toBe('puru');
		expect(claims.experiments).toEqual({ mode: 'hydrated' }); // sticky on sub, carried FOR puru
		// …and the whole thing verifies at the MFE's door (claims are signature-bound)
		const v = verify_fragment_request(
			{ publicKeys: [pub_b64] },
			new Request(seen.url!, { headers: seen.headers }),
			seen.url!
		);
		expect(v?.user?.sub).toBe('puru');
	});

	it('opts.user overrides the identity; experiments still auto-carry', async () => {
		const seen = capture_hop();
		const app = routes(
			{
				'/cms/[...rest]': mount('http://mfe.test', {
					sign: { privateKey: priv_b64 },
					user: () => ({ sub: 'service-account' })
				})
			},
			{ visitor: () => ({ sub: 'puru' }), experiments: [mode] }
		);
		await app.fetch(new Request('http://shell/cms/hello'));
		const claims = decode_claims(seen.headers!);
		expect(claims.sub).toBe('service-account');
		expect(claims.experiments?.mode).toBeDefined();
	});

	it('STATUS CHANNEL: a mounted 404 answers 404 through the shell (no 200-wrapped errors)', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ status: 404, title: 'not found', css: [], body: 'MFE 404 page' }))
		);
		const app = routes({ '/cms/[...rest]': mount('http://mfe.test') });
		const res = await app.fetch(new Request('http://shell/cms/nope'));
		expect(res!.status).toBe(404); // the shell's OWN status
		expect(await res!.text()).toContain('MFE 404 page'); // the MFE's error page still renders
	});

	it('HEAD CHANNEL: the doc `head` joins the document head', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(
				JSON.stringify({
					status: 200,
					title: 't',
					css: [],
					head: '<meta name="description" content="from the MFE">',
					body: 'B'
				})
			)
		);
		const app = routes({ '/cms/[...rest]': mount('http://mfe.test') });
		const html = await (await app.fetch(new Request('http://shell/cms/p')))!.text();
		expect(html).toContain('<meta name="description" content="from the MFE">');
	});

	it('expose() extracts SEO meta + canonical into `head`, never charset/viewport/http-equiv', async () => {
		const fake_router = {
			fetch: async () =>
				new Response(
					'<html><head><title>T</title>' +
						'<meta charset="utf-8"><meta name="viewport" content="w"><meta http-equiv="x" content="y">' +
						'<meta name="description" content="Hello"><meta property="og:image" content="https://cms.example/social.png">' +
						'<link rel="canonical" href="/posts/1">' +
						'</head><body>B</body></html>'
				)
		};
		const { GET } = expose(fake_router as never, { verify: false });
		const url = new URL('http://mfe.test/og/fragment/page?path=/posts/1');
		const doc = await (await GET({ request: new Request(url), url })).json();
		expect(doc.head).toContain('name="description"');
		// canonical stays PATH-relative (app-local link — the shell owns the address space);
		// social image content passes through verbatim (crawlers need absolute; MFEs write absolute)
		expect(doc.head).toContain('<link rel="canonical" href="/posts/1">');
		expect(doc.head).toContain('https://cms.example/social.png');
		expect(doc.head).not.toContain('charset');
		expect(doc.head).not.toContain('viewport');
		expect(doc.head).not.toContain('http-equiv');
	});

	it('a hostile document TITLE is escaped into the head (raw-head emitter law)', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(
				JSON.stringify({ status: 200, title: '</title><script>x</script>', css: [], body: 'B' })
			)
		);
		const app = routes({ '/cms/[...rest]': mount('http://mfe.test') });
		const html = await (await app.fetch(new Request('http://shell/cms/p')))!.text();
		expect(html).not.toContain('<script>x</script>');
		expect(html).toContain('&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;');
	});

	it('anonymous + no experiments = NO claims header at all', async () => {
		const seen = capture_hop();
		const app = routes({
			'/cms/[...rest]': mount('http://mfe.test', { sign: { privateKey: priv_b64 } })
		});
		await app.fetch(new Request('http://shell/cms/hello'));
		expect(seen.headers!['x-og-user']).toBeUndefined();
		expect(seen.headers!['x-og-sig']).toBeDefined(); // hop is still signed
	});
});

describe('verify_fragment_request — hardening', () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	// a distinct SECOND authorized caller sharing the same verifier (the multi-key / multi-MFE setup)
	const { publicKey: pub2k, privateKey: priv2k } = generateKeyPairSync('ed25519');
	const pub2 = pub2k.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv2 = priv2k.export({ type: 'pkcs8', format: 'der' }).toString('base64');

	const signed_req = (url: string, priv_key = priv, audience?: string) => {
		const u = new URL(url);
		const h = sign_headers(priv_key, 'GET', u, undefined, { sub: 'u1' }, audience);
		return new Request(u, { headers: h });
	};

	it('accepts a fresh, correctly-signed, right-audience request once', () => {
		const req = signed_req('http://cms.test/og/fragment/page?path=/');
		const v = verify_fragment_request({ publicKeys: [pub] }, req, new URL(req.url));
		expect(v?.user?.sub).toBe('u1');
	});

	it('AUDIENCE BINDING: a hop signed for cms.test is rejected at dash.test (same key)', () => {
		// the confused-deputy: dash trusts the same caller key, serves the same fixed path
		const req = signed_req('http://cms.test/og/fragment/page?path=/');
		const at_dash = new Request('http://dash.test/og/fragment/page?path=/', {
			headers: Object.fromEntries(req.headers)
		});
		const v = verify_fragment_request({ publicKeys: [pub] }, at_dash, new URL(at_dash.url));
		expect(v).toBeNull();
	});

	it('AUDIENCE override: explicit label survives a Host rewrite between the hops', () => {
		// signer binds label "cms-canonical"; the process sees an internal host — explicit audience matches
		const req = signed_req('http://cms.internal:9000/og/fragment/page?path=/', priv, 'cms-canonical');
		const seen = new Request('http://10.0.0.5:9000/og/fragment/page?path=/', {
			headers: Object.fromEntries(req.headers)
		});
		expect(
			verify_fragment_request({ publicKeys: [pub], audience: 'cms-canonical' }, seen, new URL(seen.url))
				?.user?.sub
		).toBe('u1');
		// …but the default host-based verifier rejects it (bound audience ≠ seen host)
		expect(verify_fragment_request({ publicKeys: [pub] }, seen, new URL(seen.url))).toBeNull();
	});

	it('REPLAY: a byte-identical second delivery of the same signature is rejected', () => {
		const req = signed_req('http://cms.test/og/fragment/page?path=/uniq-replay');
		const url = new URL(req.url);
		const headers = Object.fromEntries(req.headers);
		expect(verify_fragment_request({ publicKeys: [pub] }, req, url)?.user?.sub).toBe('u1');
		const replayed = new Request(url, { headers });
		expect(verify_fragment_request({ publicKeys: [pub] }, replayed, url)).toBeNull();
	});

	it('NaN timestamp does not bypass the freshness gate', () => {
		const req = signed_req('http://cms.test/og/fragment/page?path=/');
		const forged = new Request(req.url, {
			headers: { ...Object.fromEntries(req.headers), 'x-og-ts': 'not-a-number' }
		});
		expect(verify_fragment_request({ publicKeys: [pub] }, forged, new URL(forged.url))).toBeNull();
	});

	it('a stale timestamp (outside the window) is rejected', () => {
		const u = new URL('http://cms.test/og/fragment/page?path=/');
		const h = sign_headers(priv, 'GET', u, undefined, { sub: 'u1' });
		const old = String(Number(h['x-og-ts']) - 200_000); // 200s ago, past the 120s window
		// re-sign for the old ts so the signature itself is valid — only freshness should fail
		const h2 = sign_headers(priv, 'GET', u, undefined, { sub: 'u1' });
		const forged = new Request(u, { headers: { ...h2, 'x-og-ts': old } });
		expect(verify_fragment_request({ publicKeys: [pub] }, forged, u)).toBeNull();
	});

	it('a second authorized key in the list still verifies (rotation / multi-caller)', () => {
		const req = signed_req('http://cms.test/og/fragment/page?path=/k2', priv2);
		expect(
			verify_fragment_request({ publicKeys: [pub, pub2] }, req, new URL(req.url))?.user?.sub
		).toBe('u1');
	});

	it('tampered claims (re-encoded x-og-user) break the signature', () => {
		const req = signed_req('http://cms.test/og/fragment/page?path=/');
		const evil = Buffer.from(JSON.stringify({ sub: 'u1', roles: ['admin'] })).toString('base64');
		const forged = new Request(req.url, {
			headers: { ...Object.fromEntries(req.headers), 'x-og-user': evil }
		});
		expect(verify_fragment_request({ publicKeys: [pub] }, forged, new URL(forged.url))).toBeNull();
	});
});

describe('kitMount — mounting from a PLAIN Kit catchall (no ogygia router)', () => {
	const ev = (path: string, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		return {
			params: { rest: path },
			url: new URL('http://shell/cms/' + path),
			request: new Request('http://shell/cms/' + path, init),
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h),
			headers
		};
	};

	it('load returns the doc + per-team Server-Timing via Kit setHeaders', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ status: 200, title: 't', css: [], body: 'B', server_ms: 7 }))
		);
		const m = kitMount('http://mfe.test');
		const e = ev('hello');
		const { doc } = await m.load(e);
		expect(doc.body).toBe('B');
		expect(e.headers['server-timing']).toContain('-render;dur=7');
	});

	it('an upstream 404 becomes Kit error(404) — correct status through a plain Kit shell', async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ status: 404, title: 'nope', css: [], body: 'x' }))
		);
		const m = kitMount('http://mfe.test');
		await expect(m.load(ev('missing'))).rejects.toMatchObject({ status: 404 });
	});

	it("the MFE's PRG redirect re-throws as a Kit redirect (load + action)", async () => {
		vi.stubGlobal('fetch', async () =>
			new Response(JSON.stringify({ status: 303, location: '/cms/posts/1', title: '', css: [], body: '' }))
		);
		const m = kitMount('http://mfe.test');
		await expect(m.load(ev('old'))).rejects.toMatchObject({ status: 303, location: '/cms/posts/1' });
		await expect(
			m.actions.default(ev('posts/1', { method: 'POST', body: 'comment=hi' }))
		).rejects.toMatchObject({ status: 303, location: '/cms/posts/1' });
	});
});

describe('catalog — the MFE widget door', () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
	const widgets = {
		kpis: async (props: Record<string, string>, info: { user?: { sub?: string } }) => ({
			html: `<section data-org="${props.org}">for ${info.user?.sub ?? 'anon'} <a href="/_app/immutable/x.css">s</a></section>`
		})
	};
	const ev = (name: string, search = '', headers: Record<string, string> = {}) => {
		const url = new URL(`http://dash.test/og/fragment/${name}${search}`);
		return { params: { name }, url, request: new Request(url, { headers }) };
	};

	it('__catalog answers the manifest — the CI-diffable inventory', async () => {
		const { GET } = catalog(widgets, { verify: false });
		const res = await GET(ev('__catalog'));
		expect(await res.json()).toEqual({ names: ['kpis'] });
	});

	it('bakes a widget with claims + absolutized asset refs', async () => {
		const { GET } = catalog(widgets, { verify: { publicKeys: [pub] } });
		const e = ev('kpis', '?org=acme');
		const signed = sign_headers(priv, 'GET', e.url, undefined, { sub: 'puru' });
		const doc = await (await GET(ev('kpis', '?org=acme', signed))).json();
		expect(doc.html).toContain('data-org="acme"');
		expect(doc.html).toContain('for puru'); // signature-bound claims reached the widget
		expect(doc.html).toContain('http://dash.test/_app/immutable/x.css'); // absolutized
		expect(doc.trace?.trace_id).toMatch(/^[0-9a-f]{32}$/);
	});

	it('unsigned → 401 before any bake; unknown name → 404', async () => {
		const { GET } = catalog(widgets, { verify: { publicKeys: [pub] } });
		expect((await GET(ev('kpis'))).status).toBe(401);
		const open = catalog(widgets, { verify: false });
		expect((await open.GET(ev('nope'))).status).toBe(404);
	});
});

describe('proxy — browser edge', () => {
	const stub_widget = (): { seen: string[] } => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (u: URL) => {
			seen.push(new URL(u).pathname);
			return new Response(JSON.stringify({ html: '<div>w</div>' }));
		});
		return { seen };
	};
	const ev = (name: string, search = '') => ({
		params: { name },
		url: new URL(`http://shell/og/frag/${name}${search}`),
		request: new Request('http://shell/x')
	});

	it('allowlist: a name outside `widgets` never reaches the MFE (404, no fetch)', async () => {
		const { seen } = stub_widget();
		const dash = client('http://dash.test');
		const { GET } = proxy({ dash }, { widgets: { dash: ['kpis'] } });
		const res = await GET(ev('dash:secret-admin'));
		expect(res.status).toBe(404);
		expect((await res.json()).failed).toBe(true);
		expect(seen).toHaveLength(0); // open-proxy call never happened
	});

	it('allowlist: an allowed name is forwarded', async () => {
		const { seen } = stub_widget();
		const dash = client('http://dash.test');
		const { GET } = proxy({ dash }, { widgets: { dash: ['kpis'] } });
		const res = await GET(ev('dash:kpis', '?org=acme'));
		expect(res.status).toBe(200);
		expect(seen).toEqual(['/og/fragment/kpis']);
	});

	it('unknown app and unknown name give the SAME 404 (no catalog enumeration)', async () => {
		stub_widget();
		const dash = client('http://dash.test');
		const { GET } = proxy({ dash }, { widgets: { dash: ['kpis'] } });
		const a = await GET(ev('nope:x'));
		const b = await GET(ev('dash:not-listed'));
		expect(a.status).toBe(404);
		expect(b.status).toBe(404);
		expect(await a.json()).toEqual(await b.json());
	});
});

describe('scale bounds', () => {
	it('client cache is a bounded LRU: cold keys evict, a TOUCHED key survives', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => new Response(doc_json(`v${++calls}`)));
		// max 3 entries — the visitor rides the cache key, so unbounded = visitors×paths leak
		const cms = client('http://mfe.test', { cache: { ttl: 60_000, max: 3 } });
		await cms.doc('/a', '');
		await cms.doc('/b', '');
		await cms.doc('/c', '');
		expect(calls).toBe(3);
		await cms.doc('/a', ''); // touch /a — most recent now
		expect(calls).toBe(3); // hit
		await cms.doc('/d', ''); // 4th key → evicts LRU (/b, not the touched /a)
		expect(calls).toBe(4);
		await cms.doc('/a', ''); // survived the eviction
		expect(calls).toBe(4);
		await cms.doc('/b', ''); // was evicted → refetch
		expect(calls).toBe(5);
	});

	it('expose caps the forwarded body BEFORE buffering (413, even pre-auth)', async () => {
		const app = routes({ '/x': { POST: (c) => c.json({ ok: true }) } });
		const { POST } = expose(app, { verify: false, maxBodyBytes: 1024 });
		// content-length up front → O(1) reject, nothing buffered
		const big = new Request('http://mfe/og/fragment/page?path=/x', {
			method: 'POST',
			headers: { 'content-length': String(10 * 1024 * 1024) },
			body: 'x'
		});
		expect((await POST({ request: big, url: new URL(big.url) })).status).toBe(413);
		// a body that lies (no honest content-length) is caught right after the read
		const sneaky = new Request('http://mfe/og/fragment/page?path=/x', {
			method: 'POST',
			body: 'y'.repeat(4096)
		});
		sneaky.headers.delete('content-length');
		expect((await POST({ request: sneaky, url: new URL(sneaky.url) })).status).toBe(413);
		// a small body still flows through
		const ok = new Request('http://mfe/og/fragment/page?path=/x', { method: 'POST', body: 'z' });
		expect((await POST({ request: ok, url: new URL(ok.url) })).status).toBe(200);
	});
});
