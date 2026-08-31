/**
 * The devtools EVENT BUS — the whole product's spine (internal/notes/devtools.md, Rung 0).
 *
 * `emit()` is the one entry point. Behind it: a capped RING BUFFER (so a long-lived tab / server
 * can't grow it unbounded) plus a set of pluggable SINKS (postMessage for the REPL, a window hook
 * for e2e, console for debugging, buffer→JSON for traces). Nothing here has a UI opinion — every
 * product (our own e2e, the REPL, the future Vite plugin) is a listener over this.
 *
 * ZERO-COST WHEN OFF. `DEVTOOLS` is a compile-time constant from the `__OGYGIA_DEVTOOLS__` Vite
 * `define` (typeof-guarded exactly like `__OGYGIA_SERVER_DELTA__`, so a plain `node` import of
 * `dist/` without the define falls back to `false`). Call sites guard with a MODULE-LOCAL
 * `const DEVTOOLS = …` (the proven DCE pattern — see runtime/form-continuity.ts): when off, the
 * whole `if (DEVTOOLS) emit({…})` — object literal included — folds to `if (false)` and is dropped,
 * and this module, now unreferenced, tree-shakes out of the app's runtime chunk entirely.
 *
 * STATE IS GLOBAL-PINNED. The island runtime chunk, each island entry, and the transport-hook graph
 * are SEPARATE bundles that each carry their own copy of this module — but hub mints (ref.ts) and
 * region wakes (core.ts) emit from whichever copy runs. Pinning the buffer to `globalThis` (like the
 * hub registry and the frame store) keeps every copy writing into the ONE buffer a sink exposes.
 * No top-level side effect: the global is created lazily on first `emit`/`configure`, so an unused
 * import is fully shakeable.
 */
import { DEVTOOLS_SCHEMA_VERSION, type DevtoolsEvent, type DevtoolsEventInput } from './schema.js';

/** Compile-time gate (Vite `define`). Exported for the public surface + tests; seam modules declare
 *  their OWN local `const DEVTOOLS` from the same token so DCE never depends on cross-module folding. */
export const DEVTOOLS: boolean =
	typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** Which half of the framework this bundle is running in (a trace merges both streams). */
const REALM: 'client' | 'server' = typeof window !== 'undefined' ? 'client' : 'server';

/** A sink is any consumer of stamped events. Throwing is contained — one bad sink never starves the
 *  others, and never breaks the framework path that emitted the event. */
export type DevtoolsSink = (event: DevtoolsEvent) => void;

/** Default ring-buffer capacity (events). Small — instruments read live; a trace drains on demand. */
const DEFAULT_CAP = 4096;

interface BusState {
	/** Runtime kill-switch. Defaults to {@link DEVTOOLS}; `configure({ active:false })` pauses without
	 *  a rebuild (a devtools build that wants a quiet window). */
	active: boolean;
	/** Monotonic sequence — orders events that share a timestamp. */
	seq: number;
	/** Ring capacity. */
	cap: number;
	/** Ring storage (length === cap once warmed); `write` is the next slot, `count` caps at `cap`. */
	ring: (DevtoolsEvent | undefined)[];
	write: number;
	count: number;
	sinks: Set<DevtoolsSink>;
	/** event-name → keep 1-in-N (high-frequency discipline, e.g. hub.resolve). Absent → keep all. */
	sample: Map<string, number>;
	/** per-name running counter for the sampler. */
	sample_n: Map<string, number>;
}

const BUS_KEY = Symbol.for('ogygia.devtools.bus');

function bus(): BusState {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[BUS_KEY] as BusState | undefined) ??= {
		active: DEVTOOLS,
		seq: 0,
		cap: DEFAULT_CAP,
		ring: new Array(DEFAULT_CAP),
		write: 0,
		count: 0,
		sinks: new Set(),
		sample: new Map(),
		sample_n: new Map()
	});
}

/** High-resolution monotonic clock where available; wall-clock otherwise. */
function now(): number {
	if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
		return performance.now();
	}
	return Date.now();
}

/** Sampling gate: keep 1-in-N for a name that opted in, else keep all. */
function passes_sample(b: BusState, name: string): boolean {
	const n = b.sample.get(name);
	if (n === undefined || n <= 1) return true;
	const c = (b.sample_n.get(name) ?? 0) + 1;
	b.sample_n.set(name, c % n);
	return c % n === 0;
}

/**
 * THE emit entry point. Stamps the envelope (v / seq / t / realm), rings the buffer, fans to sinks.
 * A no-op when the bus is inactive. Guard the CALL with a module-local `if (DEVTOOLS)` so the event
 * literal compiles out entirely when off — this internal guard only protects direct/dynamic callers.
 */
export function emit(input: DevtoolsEventInput): void {
	if (!DEVTOOLS) return;
	const b = bus();
	if (!b.active) return;
	if (!passes_sample(b, input.name)) return;
	const event = {
		...input,
		v: DEVTOOLS_SCHEMA_VERSION,
		seq: b.seq++,
		t: now(),
		realm: REALM
	} as DevtoolsEvent;
	b.ring[b.write] = event;
	b.write = (b.write + 1) % b.cap;
	if (b.count < b.cap) b.count++;
	if (b.sinks.size) {
		for (const sink of b.sinks) {
			try {
				sink(event);
			} catch {
				/* a sink throwing must never break the framework path that emitted */
			}
		}
	}
}

/**
 * Push ALREADY-STAMPED events into the buffer + sinks WITHOUT re-stamping — the ingest path for the
 * server realm's events, which arrive from the `application/ogygia-devtools` side-channel carrying
 * their own envelope (v / seq / t / realm:'server'). This is what unifies the server render stream
 * and the client wake stream into ONE `window.__ogygia_devtools` timeline, correlated by fingerprint.
 */
export function ingest(events: DevtoolsEvent[]): void {
	if (!DEVTOOLS) return;
	const b = bus();
	if (!b.active) return;
	for (const event of events) {
		b.ring[b.write] = event;
		b.write = (b.write + 1) % b.cap;
		if (b.count < b.cap) b.count++;
		if (b.sinks.size) {
			for (const sink of b.sinks) {
				try {
					sink(event);
				} catch {
					/* a sink throwing must never break ingest */
				}
			}
		}
	}
}

/** Buffered events in emission order (oldest → newest). Copies out — safe to hold/serialize. */
export function snapshot(): DevtoolsEvent[] {
	const b = bus();
	const out: DevtoolsEvent[] = [];
	if (b.count === b.cap) {
		for (let i = 0; i < b.cap; i++) {
			const ev = b.ring[(b.write + i) % b.cap];
			if (ev) out.push(ev);
		}
	} else {
		for (let i = 0; i < b.count; i++) {
			const ev = b.ring[i];
			if (ev) out.push(ev);
		}
	}
	return out;
}

/** Drop every buffered event (the sinks are left registered). Used between e2e scenarios + traces. */
export function clear(): void {
	const b = bus();
	b.ring = new Array(b.cap);
	b.write = 0;
	b.count = 0;
}

/** Register a sink; returns an unregister fn. A sink sees events from registration onward — to also
 *  replay what's buffered, iterate {@link snapshot} first. */
export function add_sink(sink: DevtoolsSink): () => void {
	const b = bus();
	b.sinks.add(sink);
	return () => b.sinks.delete(sink);
}

/** Runtime configuration — pause/resume, resize the ring, set per-name sampling. */
export function configure(opts: {
	active?: boolean;
	cap?: number;
	sample?: Record<string, number>;
}): void {
	const b = bus();
	if (typeof opts.active === 'boolean') b.active = opts.active;
	if (typeof opts.cap === 'number' && opts.cap > 0 && opts.cap !== b.cap) {
		// Resize by re-ringing the current snapshot into a fresh buffer (keeps newest, drops overflow).
		const kept = snapshot().slice(-opts.cap);
		b.cap = opts.cap;
		b.ring = new Array(opts.cap);
		b.write = 0;
		b.count = 0;
		for (const ev of kept) {
			b.ring[b.write] = ev;
			b.write = (b.write + 1) % b.cap;
			if (b.count < b.cap) b.count++;
		}
	}
	if (opts.sample) {
		for (const [name, n] of Object.entries(opts.sample)) b.sample.set(name, n);
	}
}
