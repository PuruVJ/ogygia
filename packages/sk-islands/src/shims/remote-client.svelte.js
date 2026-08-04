// Client-side remote-function runtime for islands (replaces Kit's `__sveltekit/remote`
// on the CLIENT build only). Kit's own client remote runtime needs `app` (transport /
// encoders / decoders) which is set only by `start()` — never called under `csr = false`.
//
// This talks to the SAME server endpoints Kit serves (`<base>/<appDir>/remote/<id>`),
// using the same wire format: base64url(devalue) payload in the query string (GET) or
// JSON body (POST), and a `{ type:'result', data: devalue({ _: value, q: {...} }) }`
// response. The elaborate Map/Set/object arg reducers Kit uses are only cache-key
// optimizations; plain devalue round-trips all built-in types (Date/Map/Set/BigInt/…)
// correctly against Kit's server parser. Custom `hooks.transport` types are NOT supported.
import * as devalue from 'devalue';
import { base } from '$app/paths';

const APP_DIR = '_app'; // Kit default `kit.appDir`

function b64url(str) {
	const bytes = new TextEncoder().encode(str);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

function encodeArg(arg) {
	if (arg === undefined) return '';
	return b64url(devalue.stringify(arg));
}

function requestHeaders() {
	return {
		'x-sveltekit-pathname': location.pathname,
		'x-sveltekit-search': location.search
	};
}

async function callRemote(id, { method = 'GET', arg } = {}) {
	let res;
	if (method === 'GET') {
		const payload = encodeArg(arg);
		const url = `${base}/${APP_DIR}/remote/${id}${payload ? `?payload=${payload}` : ''}`;
		res = await fetch(url, { headers: requestHeaders() });
	} else {
		res = await fetch(`${base}/${APP_DIR}/remote/${id}`, {
			method: 'POST',
			headers: { ...requestHeaders(), 'content-type': 'application/json' },
			body: JSON.stringify({ payload: encodeArg(arg) })
		});
	}
	const json = await res.json();
	if (json.type === 'error') {
		const err = new Error(json.error?.message || `remote error ${res.status}`);
		err.status = json.status ?? res.status;
		throw err;
	}
	const data = json.data ? devalue.parse(json.data) : {};
	applyRefreshes(data);
	return data;
}

// --- reactive query cache (keyed by id + encoded payload, like Kit's query_map) ---
const cache = new Map();

class QueryResource {
	#s = $state({ loading: true, value: undefined, error: undefined });
	#promise;

	constructor(id, arg) {
		this.id = id;
		this.arg = arg;
		this.key = id + '/' + encodeArg(arg);
		this.#promise = this.#run(false);
	}

	#run(setLoading) {
		// Only mutate `#s` synchronously from refresh() (an event-handler context).
		// Never during construction (which can happen inside a template/derived).
		if (setLoading) this.#s = { loading: true, value: this.#s.value, error: undefined };
		const p = callRemote(this.id, { arg: this.arg }).then(
			(data) => {
				this.#s = { loading: false, value: data._, error: undefined };
				return data._;
			},
			(err) => {
				this.#s = { loading: false, value: undefined, error: err };
				throw err;
			}
		);
		return p;
	}

	/** internal: set value from a single-flight refresh bundled in another response */
	_set(value) {
		this.#s = { loading: false, value, error: undefined };
	}

	get current() {
		return this.#s.value;
	}
	get loading() {
		return this.#s.loading;
	}
	get error() {
		return this.#s.error;
	}
	/** re-fetch from the server; updates `.current` reactively */
	refresh() {
		this.#promise = this.#run(true);
		return this.#promise;
	}
	/** awaitable: `{await getX(arg)}` resolves to the value */
	then(onFulfilled, onRejected) {
		return this.#promise.then(onFulfilled, onRejected);
	}
	catch(onRejected) {
		return this.#promise.catch(onRejected);
	}
}

function applyRefreshes(data) {
	if (!data || !data.q) return;
	for (const key in data.q) {
		const entry = cache.get(key);
		if (entry && 'v' in data.q[key]) entry._set(data.q[key].v);
	}
}

export function query(id) {
	const fn = (arg) => {
		const key = id + '/' + encodeArg(arg);
		let entry = cache.get(key);
		if (!entry) {
			entry = new QueryResource(id, arg);
			cache.set(key, entry);
		}
		return entry;
	};
	return fn;
}

export function command(id) {
	const fn = (arg) => callRemote(id, { method: 'POST', arg }).then((data) => data._);
	return fn;
}

// --- live query (SSE stream) ---
class LiveQueryResource {
	#s = $state({ current: undefined, error: undefined, connected: false });
	#first;
	#resolveFirst;

	constructor(id, arg) {
		this.id = id;
		this.arg = arg;
		this.#first = new Promise((r) => (this.#resolveFirst = r));
		this.#connect();
	}

	async #connect() {
		try {
			const payload = encodeArg(this.arg);
			const url = `${base}/${APP_DIR}/remote/${this.id}${payload ? `?payload=${payload}` : ''}`;
			const res = await fetch(url, { headers: requestHeaders() });
			this.#s = { ...this.#s, connected: true };
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let idx;
				while ((idx = buf.indexOf('\n\n')) !== -1) {
					const line = buf.slice(0, idx).replace(/^data: /, '');
					buf = buf.slice(idx + 2);
					if (!line) continue;
					const msg = JSON.parse(line);
					if (msg.type === 'result') {
						const v = devalue.parse(msg.result);
						this.#s = { current: v, error: undefined, connected: true };
						this.#resolveFirst?.(v);
						this.#resolveFirst = null;
					} else if (msg.type === 'error') {
						this.#s = { ...this.#s, error: new Error(msg.error?.message || 'live error') };
					}
				}
			}
		} catch (err) {
			this.#s = { ...this.#s, error: err, connected: false };
			this.#resolveFirst?.(undefined);
		}
	}

	get current() {
		return this.#s.current;
	}
	get connected() {
		return this.#s.connected;
	}
	get error() {
		return this.#s.error;
	}
	then(onFulfilled, onRejected) {
		return this.#first.then(onFulfilled, onRejected);
	}
}

export function query_live(id) {
	return (arg) => new LiveQueryResource(id, arg);
}

// Not implemented for islands (documented). Named so Kit's generated stubs resolve.
function unsupported(kind) {
	return () => () => {
		throw new Error(`[sk-islands] remote \`${kind}\` is not supported inside islands.`);
	};
}
export const form = unsupported('form');
export const prerender = unsupported('prerender');
export const query_batch = unsupported('query.batch');
