/**
 * The general I/O-wait tracker (Tier 3).
 *
 * The CPU sampler can't see waiting, and the fetch/http patch only covers HTTP.
 * This uses `async_hooks` to time the underlying I/O *primitives* — timers,
 * file reads, DNS lookups, raw sockets — and blames the app function that
 * started each one, with no wrapping of anyone's code. That is how we attribute
 * a slow `load`'s database or `setTimeout` wait to a function even though it
 * never appears on the CPU stack.
 *
 * Enabled ONLY during a recording (a stack is captured per tracked resource).
 * HTTP/TLS resources are deliberately skipped — the fetch/http patch already
 * reports those with URL + status, and undici keep-alive would inflate socket
 * lifetimes here anyway.
 */
import { nearest_app_site, register_profiler_file, type CallerSite } from './net.js';

// so this module's own frames (the AsyncHook.init callback) are skipped when we
// blame a caller, regardless of how the bundler renamed this file
register_profiler_file();

export interface IoOp {
	/** async resource type: Timeout, FSREQCALLBACK, GETADDRINFOREQWRAP, TCPWRAP, … */
	type: string;
	/** resolved caller, filled in at report time */
	caller?: string;
	/** raw caller location (bundled), resolved to source at report time */
	caller_site?: CallerSite;
	/** init → destroy duration in ms — the time the code waited on this resource */
	ms: number;
	/** still open when the window ended (long-lived socket, watcher) */
	open?: boolean;
}

// I/O primitives worth timing. PROMISE is excluded (far too many, and it is CPU
// scheduling, not I/O). HTTP/TLS are excluded — the fetch/http patch owns them.
const TRACK = new Set([
	'Timeout',
	'Immediate',
	'FSREQCALLBACK',
	'FSREQPROMISE',
	'STATWATCHER',
	'FSEVENTWRAP',
	'GETADDRINFOREQWRAP',
	'GETNAMEINFOREQWRAP',
	'QUERYWRAP',
	'TCPWRAP',
	'TCPCONNECTWRAP',
	'PIPEWRAP',
	'PIPECONNECTWRAP',
	'UDPWRAP',
	'ZLIB'
]);

const MAX = 20_000;

export interface IoRecorder {
	stop(): IoOp[];
}

/** Start timing I/O resources. Call `stop()` at the end of the window. */
export async function record_async_io(): Promise<IoRecorder | null> {
	let async_hooks: typeof import('node:async_hooks');
	try {
		async_hooks = await import('node:async_hooks');
	} catch {
		return null; // no async_hooks (edge) — the fetch patch and wall/CPU split still work
	}

	const open = new Map<number, { t: number; type: string; site?: CallerSite }>();
	const ops: IoOp[] = [];

	const hook = async_hooks.createHook({
		init(asyncId, type) {
			if (open.size >= MAX || !TRACK.has(type)) return;
			open.set(asyncId, { t: performance.now(), type, site: nearest_app_site() });
		},
		destroy(asyncId) {
			const s = open.get(asyncId);
			if (!s) return;
			open.delete(asyncId);
			if (ops.length < MAX) {
				ops.push({ type: s.type, caller_site: s.site, ms: round2(performance.now() - s.t) });
			}
		}
	});
	hook.enable();

	return {
		stop() {
			hook.disable();
			// resources still open at window end (a socket kept alive, a watcher) —
			// record their elapsed time, flagged, so nothing silently vanishes
			const now = performance.now();
			for (const s of open.values()) {
				if (ops.length < MAX) {
					ops.push({ type: s.type, caller_site: s.site, ms: round2(now - s.t), open: true });
				}
			}
			open.clear();
			return ops;
		}
	};
}

/** A friendly bucket for a resource type, for the report. */
export function io_kind(type: string): 'timer' | 'file' | 'dns' | 'socket' | 'zlib' | 'other' {
	if (type === 'Timeout' || type === 'Immediate') return 'timer';
	if (type.startsWith('FS') || type === 'STATWATCHER') return 'file';
	if (type.startsWith('GETADDR') || type.startsWith('GETNAME') || type === 'QUERYWRAP')
		return 'dns';
	if (type.includes('TCP') || type.includes('PIPE') || type === 'UDPWRAP') return 'socket';
	if (type === 'ZLIB') return 'zlib';
	return 'other';
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
