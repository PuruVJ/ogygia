// Client-side remote-function runtime for islands (replaces Kit's `__sveltekit/remote`
// on the CLIENT build only). Kit's own client remote runtime needs `app` (transport /
// encoders / decoders) which is set only by `start()` — never called under `csr = false`,
// and it is tightly coupled to Kit's full client `client.js` (the router). So we DON'T
// reimplement the wire protocol: we reuse Kit's OWN codec (`runtime/shared.js`, deep-imported
// by the vite plugin, bypassing the exports map) and feed it the app's universal `transport`
// hook — so custom transport types round-trip exactly against Kit's server parser. Only the
// thin reactive cache below (which in Kit lives in the router-coupled `client.js`) is ours.
import * as devalue from 'devalue';
import { base } from '$app/paths';
import {
	stringify_remote_arg,
	stringify_command_arg,
	create_remote_key
} from 'virtual:ogygia/kit-wire';
import { transport } from 'virtual:ogygia/transport';

const APP_DIR = '_app'; // Kit default `kit.appDir`

// Kit derives client decoders from `transport` exactly like this (write_client_manifest.js).
const decoders = Object.fromEntries(
	Object.entries(transport || {}).map(([k, v]) => [k, v.decode])
);

/** Encode a GET arg with Kit's own transport-aware codec (empty string when undefined). */
function encodeArg(arg) {
	return stringify_remote_arg(arg, transport);
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
		// `stringify_command_arg` is async (handles File) and transport-aware.
		const payload = await stringify_command_arg(arg, transport);
		res = await fetch(`${base}/${APP_DIR}/remote/${id}`, {
			method: 'POST',
			headers: { ...requestHeaders(), 'content-type': 'application/json' },
			body: JSON.stringify({ payload })
		});
	}
	const json = await res.json();
	if (json.type === 'error') {
		const err = new Error(json.error?.message || `remote error ${res.status}`);
		err.status = json.status ?? res.status;
		throw err;
	}
	const data = json.data ? devalue.parse(json.data, decoders) : {};
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
		this.key = create_remote_key(id, encodeArg(arg));
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
		const key = create_remote_key(id, encodeArg(arg));
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
						const v = devalue.parse(msg.result, decoders);
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
		throw new Error(`[ogygia] remote \`${kind}\` is not supported inside islands.`);
	};
}
export const form = unsupported('form');
export const prerender = unsupported('prerender');
export const query_batch = unsupported('query.batch');
