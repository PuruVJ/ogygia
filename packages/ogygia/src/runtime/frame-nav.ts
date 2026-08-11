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
import { reserve, release, ticket, write } from './frame-store.js';

const STREAM_DONE_SLOT = '__ogygia_done__';
// Safe non-greedy scan: `build_parcel` rejects any html containing `</template`, so the first
// close always ends the current parcel.
const PARCEL_RE = /<template data-ogygia-slot="([^"]*)">([\s\S]*?)<\/template>/g;

function sigOf(endpoint: string): string | null {
	const q = endpoint.indexOf('?');
	return q === -1 ? null : new URLSearchParams(endpoint.slice(q + 1)).get('sig');
}

/**
 * Stream a batch of region calls into the frame store. Endpoints must share an endpoint path (they
 * do — all are minted against the same `/🏝️`). Frames apply as they land; the promise resolves when
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
			PARCEL_RE.lastIndex = 0;
			let consumed = 0;
			let m: RegExpExecArray | null;
			while ((m = PARCEL_RE.exec(buffer))) {
				consumed = m.index + m[0].length;
				const [, slot, html] = m;
				if (slot === STREAM_DONE_SLOT) return; // sentinel — batch complete
				const a = bySig.get(slot);
				if (a) write({ a, v: ticket(a), html });
			}
			if (consumed) buffer = buffer.slice(consumed);
		}
	} finally {
		// Any address the batch never delivered (dropped/forged/errored) has its reservation failed, so a
		// bound binder retries with its own fetch. release() is a no-op once the frame has landed.
		for (const a of reserved) release(a);
	}
}
