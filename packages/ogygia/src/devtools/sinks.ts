/**
 * Built-in sinks + the trace format (internal/notes/devtools.md, Rung 0). Each sink is a plain
 * listener over {@link ./bus.js the bus}; none touches framework internals. Load only what you use —
 * the REPL wants `postMessage`, our e2e wants the `window` hook, a bug report wants a trace.
 */
import { add_sink, snapshot, clear, ingest, type DevtoolsSink } from './bus.js';
import { DEVTOOLS_SCHEMA_VERSION, type DevtoolsEvent } from './schema.js';

/** The global the {@link install_window_sink window sink} publishes. Distinct from the compile-time
 *  `__OGYGIA_DEVTOOLS__` define (a bare identifier the bundler replaces) — this is a real runtime
 *  object on `window`, read by Playwright `page.evaluate` across the script boundary. */
const WINDOW_HOOK = '__ogygia_devtools';

/** Shape of `window.__ogygia_devtools` (the e2e / instrument entry point). */
export interface DevtoolsWindowHook {
	/** Schema version, so a reader can gate. */
	version: number;
	/** Every buffered event, oldest → newest (a fresh copy each call). */
	events(): DevtoolsEvent[];
	/** Subscribe to events from now on; returns an unsubscribe fn. */
	on(cb: (event: DevtoolsEvent) => void): () => void;
	/** Drop the buffer (between e2e scenarios). */
	clear(): void;
	/** Serialize the buffer to a portable trace. */
	trace(): DevtoolsTrace;
}

declare global {
	interface Window {
		[WINDOW_HOOK]?: DevtoolsWindowHook;
	}
}

/**
 * Publish `window.__ogygia_devtools` so an out-of-page reader (Playwright, a devtools panel, a REPL
 * host) can pull buffered events, subscribe to new ones, and drain a trace — WITHOUT importing any
 * framework module. Idempotent. No-op off the browser. Returns the hook (or undefined on the server).
 *
 * This is what lets our e2e assert on the ISLAND LIFECYCLE directly ("interaction island fired its
 * wake, replayed exactly one click") instead of polling the DOM behind a `waitForTimeout` — the
 * bus pays for itself in our own tests first (the note's proof-of-value).
 */
export function install_window_sink(): DevtoolsWindowHook | undefined {
	if (typeof window === 'undefined') return undefined;
	const existing = window[WINDOW_HOOK];
	if (existing) return existing;
	const hook: DevtoolsWindowHook = {
		version: DEVTOOLS_SCHEMA_VERSION,
		events: () => snapshot(),
		on: (cb) => add_sink(cb),
		clear: () => clear(),
		trace: () => to_trace()
	};
	window[WINDOW_HOOK] = hook;
	return hook;
}

/**
 * Forward every event to a `postMessage` target (the REPL's tab ↔ worker ↔ iframe channel). Pass a
 * `Worker` / `MessagePort` / `Window`; each event is posted as `{ __ogygia_devtools: event }`.
 * Returns the unregister fn.
 */
export function install_postmessage_sink(target: {
	postMessage: (message: unknown) => void;
}): () => void {
	const sink: DevtoolsSink = (event) => target.postMessage({ [WINDOW_HOOK]: event });
	return add_sink(sink);
}

/** Log every event to the console (debugging). `filter` limits by domain/name substring. */
export function install_console_sink(filter?: (event: DevtoolsEvent) => boolean): () => void {
	const sink: DevtoolsSink = (event) => {
		if (filter && !filter(event)) return;
		// One compact line per event; the object is expandable in the devtools console.
		console.debug(`[ogygia:dt] ${event.domain}.${event.name}`, event);
	};
	return add_sink(sink);
}

/** A portable trace — a versioned bag of events, attachable to a bug report and replayable in the
 *  REPL later (the note's "CPU-profile energy, but for the islands lifecycle"). */
export interface DevtoolsTrace {
	/** Marker so a consumer knows what it's holding. */
	kind: 'ogygia-devtools-trace';
	/** {@link DEVTOOLS_SCHEMA_VERSION}. */
	version: number;
	/** Events in emission order. */
	events: DevtoolsEvent[];
}

/** Serialize the current buffer into a {@link DevtoolsTrace}. */
export function to_trace(): DevtoolsTrace {
	return {
		kind: 'ogygia-devtools-trace',
		version: DEVTOOLS_SCHEMA_VERSION,
		events: snapshot()
	};
}

/**
 * Read the server realm's `<script type="application/ogygia-devtools">` side-channel (injected by the
 * handle on a devtools build) and INGEST its events into the unified stream, so a region's server
 * render sits in the same `window.__ogygia_devtools` timeline as its client wake — correlated by
 * fingerprint. Idempotent per document via a marker attribute; no-op off the browser or when the
 * script is absent. Returns how many server events were ingested.
 */
export function ingest_server_events(): number {
	if (typeof document === 'undefined') return 0;
	let total = 0;
	for (const el of document.querySelectorAll(
		'script[type="application/ogygia-devtools"]:not([data-og-dt-ingested])'
	)) {
		el.setAttribute('data-og-dt-ingested', '');
		const text = el.textContent;
		if (!text) continue;
		try {
			const events = JSON.parse(text) as DevtoolsEvent[];
			if (Array.isArray(events) && events.length) {
				ingest(events);
				total += events.length;
			}
		} catch {
			/* malformed side-channel — ignore, never break boot */
		}
	}
	return total;
}
