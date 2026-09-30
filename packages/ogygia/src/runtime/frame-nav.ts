// ─────────────────────────────────────────────────────────────────────────────
// Navigation frame stream — the client half of out-of-order streaming on navigation.
//
// Given a set of signed region endpoints (the calls a route needs), POST them to the batch endpoint
// and read ONE streamed response, writing each `<template data-ogygia-slot>` frame into the store the
// moment it arrives (out of order — the slot routes it). Regions bound to those addresses apply via
// their store subscription. No per-region round trip, no fetch waterfall.
//
// This is Ryan's test made concrete: request new server-component data on navigation, flush part of
// the response, let the rest come in as the server's async settles.
// ─────────────────────────────────────────────────────────────────────────────
import { frameAddress } from '../frame.js';
import { is_idle, reserve, release, ticket, write } from './frame-store.js';

const STREAM_DONE_SLOT = '__ogygia_done__';
const OPEN = '<template data-ogygia-slot="';
const LEN = '" data-og-len="';
const CLOSE = '</template>';

type Parcel = { slot: string; html: string; end: number };

/**
 * The next whole parcel in `buf` from `from` (server/stream-regions.ts), or `null` when it has not
 * fully arrived yet. A plain parcel ends at the first `</template>` (the server length-frames any
 * answer carrying one of its own); a length-framed one is exactly `data-og-len` characters.
 */
export function read_parcel(buf: string, from: number): Parcel | null {
	const open = buf.indexOf(OPEN, from);
	if (open === -1) return null;
	const slot_at = open + OPEN.length;
	const quote = buf.indexOf('"', slot_at);
	if (quote === -1) return null;
	const slot = buf.slice(slot_at, quote);
	if (buf.startsWith('">', quote)) {
		const close = buf.indexOf(CLOSE, quote + 2);
		if (close === -1) return null;
		return { slot, html: buf.slice(quote + 2, close), end: close + CLOSE.length };
	}
	if (!buf.startsWith(LEN, quote)) {
		// (not a shape the server writes: skip past this opening, or wait for the rest of it)
		return buf.length - quote < LEN.length ? null : read_parcel(buf, slot_at);
	}
	let i = quote + LEN.length;
	let len = 0;
	for (let c = buf.charCodeAt(i); c >= 48 && c <= 57; c = buf.charCodeAt(++i)) len = len * 10 + (c - 48);
	if (i + 2 > buf.length) return null;
	if (!buf.startsWith('">', i)) return read_parcel(buf, slot_at);
	const start = i + 2;
	const end = start + len + CLOSE.length;
	if (end > buf.length) return null;
	return { slot, html: buf.slice(start, start + len), end };
}

function sigOf(endpoint: string): string | null {
	const q = endpoint.indexOf('?');
	return q === -1 ? null : new URLSearchParams(endpoint.slice(q + 1)).get('sig');
}

/**
 * Stream a batch of region calls into the frame store. Endpoints must share an endpoint path (they
 * do — all are minted against the same `/__ogygia__`). Frames apply as they land; the promise resolves when
 * the response ends.
 */
export async function streamFrames(endpoints: string[]): Promise<void> {
	if (!endpoints.length) return;
	const first = endpoints[0];
	const q = first.indexOf('?');
	const path = q === -1 ? first : first.slice(0, q);

	// slot (sig) → store address, so an arriving parcel routes to the right call. RESERVE each address
	// up front: a region binder that connects (body swap) before its frame lands joins this batch via
	// ensure() instead of firing its own fetch — one request for the whole route, no waterfall.
	const bySig = new Map<string, string>();
	const reserved: string[] = [];
	for (const e of endpoints) {
		const s = sigOf(e);
		if (s) {
			const a = frameAddress(e);
			bySig.set(s, a);
			reserved.push(a);
			reserve(a);
		}
	}

	try {
		let res: Response;
		try {
			res = await fetch(path, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(endpoints)
			});
		} catch {
			return; // network error — release() in finally lets bound regions fall back to their own fetch
		}
		if (!res.ok || !res.body) return;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let consumed = 0;
			for (let p = read_parcel(buffer, 0); p; p = read_parcel(buffer, consumed)) {
				consumed = p.end;
				if (p.slot === STREAM_DONE_SLOT) return; // sentinel — batch complete
				const a = bySig.get(p.slot);
				if (a) write({ a, v: ticket(a), html: p.html });
			}
			if (consumed) buffer = buffer.slice(consumed);
		}
	} finally {
		// Any address the batch never delivered (dropped/forged/errored) has its reservation failed, so a
		// bound binder retries with its own fetch. release() is a no-op once the frame has landed.
		for (const a of reserved) release(a);
	}
}

/** The server renders at most this many calls per batch (hooks.ts `render_batch`). */
const MAX_BATCH = 32;
let queued: string[] | null = null;
let flushed: Promise<void> = Promise.resolve();

/**
 * THE PAGE'S HOLES, ONE REQUEST. Holes that start fetching together (the above-the-fold `visible`
 * ones fire in one observer callback; `idle` and media ones in one task) join here
 * and, at the end of that task, go out as ONE batch — reserved in the store first, so each hole's
 * own fetch then JOINS its address instead of starting a request. One request instead of N: one pass
 * through the app's handle chain (its session lookup, its auth) instead of N, and no per-hole slot in
 * the browser's own few-at-a-time gate. A lone hole goes out on its own (a GET, as before); so does
 * any hole the batch does not deliver (release → its fetch runs). Resolves when the batch is on its
 * way, never with its content.
 */
export function join_batch(endpoint: string): Promise<void> {
	if (!queued) {
		queued = [];
		flushed = new Promise<void>((resolve) =>
			queueMicrotask(() => {
				const list = queued!;
				queued = null;
				const fresh: string[] = [];
				const seen = new Set<string>();
				// A `load` hole's request already started during the HTML parse (Region.svelte's
				// `<link rel="preload" as="fetch">`): its own fetch takes that response — batching it
				// would render it twice.
				const hinted = new Set<string>();
				for (const l of document.querySelectorAll('link[rel="preload"][as="fetch"]')) {
					const href = l.getAttribute('href');
					if (href) hinted.add(href);
				}
				for (const e of list) {
					const a = frameAddress(e);
					if (seen.has(a) || hinted.has(e) || !is_idle(a)) continue;
					seen.add(a);
					fresh.push(e);
				}
				// (reserve happens synchronously inside streamFrames, before this resolves)
				if (fresh.length >= 2)
					for (let i = 0; i < fresh.length; i += MAX_BATCH) void streamFrames(fresh.slice(i, i + MAX_BATCH));
				resolve();
			})
		);
	}
	queued.push(endpoint);
	return flushed;
}
