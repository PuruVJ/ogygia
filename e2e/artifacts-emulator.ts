// The EDGE EMULATOR — lane 3's heart (internal/notes/artifact.md, §Test harness).
//
// A tiny caching proxy worn with a per-CDN personality. It behaves like the CDN (obeys
// `cache-control`, keys by URL cookie-less, remembers `edge-cache-tag`s) AND exposes that CDN's
// REAL purge API surface, so ogygia's actual EdgeAdapters run against it UNCHANGED — signing
// included (auth is verified structurally). Chainable: user → akamai-emu → cloudfront-emu →
// origin (the bcms topology). Every response is stamped `x-edge-<name>: hit|miss`, and
// `/__edge/state` exposes keys/hits/misses/purge-log for deck assertions. Failure injection via
// `POST /__edge/fail { mode: 'purge-500' | 'none' }`.
import http from 'node:http';

// Hoisted auth-structure checks — the REAL adapters must produce these shapes.
const EDGEGRID_AUTH_RE =
	/^EG1-HMAC-SHA256 client_token=[^;]+;access_token=[^;]+;timestamp=\d{8}T\d\d:\d\d:\d\d\+0000;nonce=[0-9a-f-]{36};signature=[A-Za-z0-9+/=]+$/;
const SIGV4_AUTH_RE =
	/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/us-east-1\/cloudfront\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/;
const S_MAXAGE_RE = /s-maxage=(\d+)/;
const CF_PATH_RE = /<Path>([^<]+)<\/Path>/g;

interface CachedResponse {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	tags: string[];
	expires: number;
}

export interface PurgeLogEntry {
	kind: 'url' | 'tag' | 'path';
	value: string;
	auth_ok: boolean;
}

export interface EdgeEmulator {
	name: string;
	port: number;
	base: string;
	state(): { keys: string[]; hits: number; misses: number; purges: PurgeLogEntry[] };
	close(): Promise<void>;
}

/** Headers worth forwarding downstream from an upstream response. */
const FORWARD_HEADERS = [
	'content-type',
	'cache-control',
	'location',
	'edge-cache-tag',
	'set-cookie',
	'x-ogygia-artifact'
];

export function start_edge_emulator(options: {
	name: 'akamai' | 'cloudfront';
	port: number;
	upstream: string;
}): Promise<EdgeEmulator> {
	const { name, port, upstream } = options;
	const cache = new Map<string, CachedResponse>();
	const purges: PurgeLogEntry[] = [];
	let hits = 0;
	let misses = 0;
	let fail_mode: 'none' | 'purge-500' = 'none';

	const purge_path = (path: string) => {
		if (path.endsWith('/*')) {
			const prefix = path.slice(0, -2);
			for (const key of [...cache.keys()]) {
				if (key === prefix || key.startsWith(prefix + '/')) cache.delete(key);
			}
		} else {
			cache.delete(path);
		}
	};

	const read_body = (req: http.IncomingMessage): Promise<Buffer> =>
		new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => resolve(Buffer.concat(chunks)));
			req.on('error', reject);
		});

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

		// ── harness endpoints ────────────────────────────────────────────────────────────────
		if (url.pathname === '/__edge/state') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ name, keys: [...cache.keys()], hits, misses, purges }));
			return;
		}
		if (url.pathname === '/__edge/fail' && req.method === 'POST') {
			const body = JSON.parse(String(await read_body(req)) || '{}');
			fail_mode = body.mode === 'purge-500' ? 'purge-500' : 'none';
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"ok":true}');
			return;
		}

		// ── the REAL purge API surfaces ──────────────────────────────────────────────────────
		if (name === 'akamai' && url.pathname.startsWith('/ccu/v3/invalidate/')) {
			const auth_ok = EDGEGRID_AUTH_RE.test(req.headers.authorization ?? '');
			const body = JSON.parse(String(await read_body(req)) || '{}') as { objects?: string[] };
			if (fail_mode === 'purge-500') {
				res.writeHead(500, { 'content-type': 'application/json' });
				res.end('{"detail":"injected failure"}');
				return;
			}
			if (!auth_ok) {
				purges.push({ kind: 'url', value: '(bad auth)', auth_ok: false });
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end('{"detail":"bad EdgeGrid auth"}');
				return;
			}
			const is_tag = url.pathname.includes('/invalidate/tag');
			for (const obj of body.objects ?? []) {
				if (is_tag) {
					purges.push({ kind: 'tag', value: obj, auth_ok });
					for (const [key, entry] of [...cache]) {
						if (entry.tags.includes(obj)) cache.delete(key);
					}
				} else {
					const pathname = obj.startsWith('http') ? new URL(obj).pathname : obj;
					purges.push({ kind: 'url', value: pathname, auth_ok });
					cache.delete(pathname);
				}
			}
			res.writeHead(201, { 'content-type': 'application/json' });
			res.end('{"httpStatus":201,"detail":"queued"}');
			return;
		}
		if (name === 'cloudfront' && /\/\d{4}-\d\d-\d\d\/distribution\/[^/]+\/invalidation$/.test(url.pathname)) {
			const auth_ok = SIGV4_AUTH_RE.test(req.headers.authorization ?? '');
			const body = String(await read_body(req));
			if (fail_mode === 'purge-500') {
				res.writeHead(500, { 'content-type': 'text/xml' });
				res.end('<Error>injected failure</Error>');
				return;
			}
			if (!auth_ok) {
				purges.push({ kind: 'path', value: '(bad auth)', auth_ok: false });
				res.writeHead(403, { 'content-type': 'text/xml' });
				res.end('<Error>bad SigV4 auth</Error>');
				return;
			}
			for (const m of body.matchAll(CF_PATH_RE)) {
				purges.push({ kind: 'path', value: m[1], auth_ok });
				purge_path(m[1]);
			}
			res.writeHead(201, { 'content-type': 'text/xml' });
			res.end('<Invalidation><Status>InProgress</Status></Invalidation>');
			return;
		}

		// ── the CDN data path: cookie-less URL key, honor cache-control ──────────────────────
		const key = url.pathname;
		const cacheable_read = req.method === 'GET' && url.search === '';
		if (cacheable_read) {
			const entry = cache.get(key);
			if (entry && Date.now() < entry.expires) {
				hits++;
				res.writeHead(entry.status, { ...entry.headers, [`x-edge-${name}`]: 'hit' });
				res.end(entry.body);
				return;
			}
		}
		misses++;
		let upstream_res: Response;
		try {
			upstream_res = await fetch(upstream + url.pathname + url.search, {
				method: req.method,
				headers: {
					...(req.headers.cookie ? { cookie: String(req.headers.cookie) } : {}),
					...(req.headers.origin ? { origin: String(req.headers.origin) } : {}),
					...(req.headers['content-type']
						? { 'content-type': String(req.headers['content-type']) }
						: {})
				},
				// Uint8Array, not Buffer — Node's TS lib doesn't admit Buffer as BodyInit.
				body:
					req.method === 'GET' || req.method === 'HEAD'
						? undefined
						: new Uint8Array(await read_body(req)),
				redirect: 'manual'
			});
		} catch {
			res.writeHead(502, { [`x-edge-${name}`]: 'origin-down' });
			res.end('bad gateway');
			return;
		}
		const body = Buffer.from(await upstream_res.arrayBuffer());
		const headers: Record<string, string> = {};
		for (const h of FORWARD_HEADERS) {
			const v = upstream_res.headers.get(h);
			if (v !== null) headers[h] = v;
		}
		const cc = headers['cache-control'] ?? '';
		const s_maxage = Number(S_MAXAGE_RE.exec(cc)?.[1] ?? 0);
		const storable =
			cacheable_read &&
			upstream_res.status === 200 &&
			s_maxage > 0 &&
			!cc.includes('private') &&
			!cc.includes('no-store') &&
			!headers['set-cookie'];
		if (storable) {
			cache.set(key, {
				status: upstream_res.status,
				headers,
				body,
				tags: (headers['edge-cache-tag'] ?? '')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean),
				expires: Date.now() + s_maxage * 1000
			});
		}
		res.writeHead(upstream_res.status, { ...headers, [`x-edge-${name}`]: 'miss' });
		res.end(body);
	});

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			resolve({
				name,
				port,
				base: `http://127.0.0.1:${port}`,
				state: () => ({ keys: [...cache.keys()], hits, misses, purges }),
				close: () => new Promise<void>((r) => server.close(() => r()))
			});
		});
	});
}
