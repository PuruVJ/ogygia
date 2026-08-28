/**
 * EXPERIMENTAL — cross-fragment shared state: the Svelte-native cross-BUILD primitive.
 *
 * `new SharedState(name, initial)` in a tiny CONTRACT package every team depends on; each build
 * compiles its own copy of the class, but all copies meet at ONE page-global store keyed by
 * `Symbol.for` (same key in every realm/build). Reads are `.current` (the Svelte convention —
 * MediaQuery/Spring), reactive via `createSubscriber`; nested writes (`cart.current.items.push`)
 * publish through a mutation proxy. No subscriptions, no callbacks, no server involved: one
 * page, one value, every island of every team re-renders on write.
 *
 * Cross-language: any server can SEED the opening value by printing
 * `<script type="application/json" data-og-shared="<name>">{…}</script>`, and any vanilla JS on
 * the page can join via `globalThis.ogygia.shared(name)` → { get, set, subscribe }.
 */
import { createSubscriber } from 'svelte/reactivity';
import { parse, stringify } from 'devalue';

interface Entry {
	value: unknown;
	version: number;
}
interface Store {
	map: Map<string, Entry>;
	target: EventTarget;
}

const STORE_KEY = Symbol.for('ogygia.shared.v1');

function page_store(): Store {
	const g = globalThis as Record<PropertyKey, unknown>;
	if (!g[STORE_KEY]) g[STORE_KEY] = { map: new Map(), target: new EventTarget() } satisfies Store;
	return g[STORE_KEY] as Store;
}

/** Read a server-printed seed: `<script type="application/json" data-og-shared="<name>">`. */
function read_seed(name: string): unknown | undefined {
	if (typeof document === 'undefined') return undefined;
	const el = document.querySelector(
		`script[type="application/json"][data-og-shared=${JSON.stringify(name)}]`
	);
	if (!el?.textContent) return undefined;
	try {
		return JSON.parse(el.textContent);
	} catch {
		return undefined;
	}
}

/** THE MEMBRANE: only inert data enters the page store — the two builds' svelte runtimes must
 *  never see each other's live values. A devalue ROUND-TRIP is the membrane on purpose:
 *  devalue-representable is ogygia's definition of "can cross a boundary" (props sidecars, page
 *  seeds, transport — one vocabulary), so a value that passes here is also seedable/serializable
 *  everywhere else. A reactive proxy degrades to a plain snapshot (safe — and what you meant);
 *  functions, class instances, and DOM nodes THROW here, loudly, at the write site — with
 *  devalue's path detail — never weirdly at a distance inside another team's render. */
function snapshot<T>(name: string, value: T): T {
	try {
		return parse(stringify(value)) as T;
	} catch (e) {
		throw new Error(
			`[ogygia] SharedState '${name}': values must be plain data (devalue-serializable — ` +
				`JSON, Date, Map, Set, BigInt, RegExp). Functions, class instances, and DOM nodes ` +
				`do not cross build boundaries — share facts, not live objects. ` +
				`(${e instanceof Error ? e.message : e})`
		);
	}
}

export class SharedState<T extends object> {
	#name: string;
	#subscribe: () => void;
	#publish_queued = false;

	constructor(name: string, initial: T) {
		this.#name = name;
		const store = page_store();
		if (!store.map.has(name)) {
			// first build to touch the name creates the entry; a server-printed seed wins over
			// the contract's default (the opening value is the SERVING page's truth). Both enter
			// through the membrane — the store never holds anything alive.
			const seed = read_seed(name);
			store.map.set(name, {
				value: seed !== undefined ? seed : snapshot(name, initial),
				version: 0
			});
		}
		this.#subscribe = createSubscriber((update) => {
			const on = (e: Event) => {
				if ((e as CustomEvent).detail === name) update();
			};
			store.target.addEventListener('og:shared', on);
			return () => store.target.removeEventListener('og:shared', on);
		});
	}

	#publish() {
		// mutations arrive in bursts (push = index set + length set) — one notification per microtask
		if (this.#publish_queued) return;
		this.#publish_queued = true;
		queueMicrotask(() => {
			this.#publish_queued = false;
			const store = page_store();
			const entry = store.map.get(this.#name)!;
			entry.version++;
			store.target.dispatchEvent(new CustomEvent('og:shared', { detail: this.#name }));
		});
	}

	/** Deep mutation proxy: any nested write publishes. Functions pass through raw (their `this`
	 *  is the proxy, so array methods still trip the set traps). */
	#proxy(value: unknown): unknown {
		if (value === null || typeof value !== 'object') return value;
		const publish = () => this.#publish();
		const wrap = this.#proxy.bind(this);
		// Internal-slot built-ins (Map/Set/Date/RegExp) reject a Proxy receiver, so their methods
		// run against the TARGET and any call publishes (microtask-debounced, so a read-heavy
		// pattern costs one notification, not N). Plain objects/arrays keep the trap path —
		// array methods called with the proxy receiver trip the set traps naturally.
		const slotted =
			value instanceof Map ||
			value instanceof Set ||
			value instanceof Date ||
			value instanceof RegExp;
		if (slotted) {
			return new Proxy(value as object, {
				get: (t, p) => {
					const v = Reflect.get(t, p);
					if (typeof v !== 'function') return v;
					return (...args: unknown[]) => {
						const r = (v as (...a: unknown[]) => unknown).apply(t, args);
						publish();
						return r;
					};
				}
			});
		}
		return new Proxy(value as object, {
			get: (t, p) => wrap(Reflect.get(t, p)),
			set: (t, p, v) => {
				Reflect.set(t, p, v);
				publish();
				return true;
			},
			deleteProperty: (t, p) => {
				Reflect.deleteProperty(t, p);
				publish();
				return true;
			}
		});
	}

	/** The value — reactive wherever Svelte is watching, plain everywhere else. */
	get current(): T {
		this.#subscribe();
		return this.#proxy(page_store().map.get(this.#name)!.value) as T;
	}

	set current(v: T) {
		page_store().map.get(this.#name)!.value = snapshot(this.#name, v);
		this.#publish();
	}
}

// ── vanilla-JS door (legacy code on any host page) ────────────────────────────────────────────
interface VanillaHandle {
	get(): unknown;
	set(v: unknown): void;
	subscribe(fn: (v: unknown) => void): () => void;
}

function vanilla(name: string): VanillaHandle {
	const store = page_store();
	if (!store.map.has(name)) store.map.set(name, { value: read_seed(name), version: 0 });
	return {
		get: () => store.map.get(name)!.value,
		set: (v) => {
			const entry = store.map.get(name)!;
			entry.value = snapshot(name, v); // same membrane as the Svelte door
			entry.version++;
			store.target.dispatchEvent(new CustomEvent('og:shared', { detail: name }));
		},
		subscribe: (fn) => {
			const on = (e: Event) => {
				if ((e as CustomEvent).detail === name) fn(store.map.get(name)!.value);
			};
			store.target.addEventListener('og:shared', on);
			return () => store.target.removeEventListener('og:shared', on);
		}
	};
}

if (typeof globalThis !== 'undefined') {
	const g = globalThis as { ogygia?: Record<string, unknown> };
	g.ogygia ??= {};
	g.ogygia.shared ??= vanilla;
}
