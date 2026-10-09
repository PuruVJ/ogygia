/**
 * THE HOLES RECORD — what the server minted for each deferred hole on a KIT-HYDRATED document,
 * keyed by the hole's identity (`data-og-hole`: the fingerprint of region id + canonical props,
 * computed the same way on both legs). The handle emits it in the document tail
 * (`<script type="application/ogygia-holes">`, server/document-tail.ts), OUTSIDE Kit's root.
 *
 * Why it exists: Kit can give up hydrating such a document — a component threw while hydrating,
 * the markup mismatched — and Svelte then clears Kit's root and mounts it fresh. Every hole is
 * rendered again by the client leg, which cannot mint a signed address: `endpoint=""`, no props
 * sidecar, the fallback standing forever (a site header's account holes went dark this way for
 * signed-in visitors). The record survives the rebuild, so a rebuilt hole gets its facts back the
 * moment it connects, by identity — never by position — and fetches exactly as the SSR element
 * would have. Read lazily, parsed once per document.
 */
import { HOLES_SCRIPT_TYPE } from '../holes-record.js';

export type HoleFacts = {
	/** The signed capability URL the server minted. */
	endpoint: string;
	/** A hydrating hole's props sidecar, rebuilt from the recorded HTML; `null` for a static hole. */
	sidecar: HTMLScriptElement | null;
};

const HOLES_SELECTOR = `script[type="${HOLES_SCRIPT_TYPE}"]`;

type RawRecord = Record<string, { endpoint?: unknown; sidecar?: unknown }>;

/** One parse per document: the record, or `null` when the document carries none. */
const records = new WeakMap<Document, Map<string, HoleFacts> | null>();

function parse_record(doc: Document): Map<string, HoleFacts> | null {
	const el = doc.querySelector(HOLES_SELECTOR);
	if (!el) return null;
	let raw: RawRecord;
	try {
		raw = JSON.parse(el.textContent || '') as RawRecord;
	} catch {
		return null;
	}
	const map = new Map<string, HoleFacts>();
	for (const identity in raw) {
		const entry = raw[identity];
		if (!entry || typeof entry.endpoint !== 'string' || !entry.endpoint) continue;
		map.set(identity, {
			endpoint: entry.endpoint,
			sidecar: typeof entry.sidecar === 'string' && entry.sidecar ? sidecar_element(doc, entry.sidecar) : null
		});
	}
	return map;
}

/** The recorded sidecar HTML back into a script element (off the DOM; a `<template>` parses it
 *  without running anything — the sidecar is a data script, never executable). */
function sidecar_element(doc: Document, html: string): HTMLScriptElement | null {
	const holder = doc.createElement('template');
	holder.innerHTML = html;
	const el = holder.content.firstElementChild;
	return el && el.tagName === 'SCRIPT' ? (el as HTMLScriptElement) : null;
}

/** The server-minted facts of the hole with this identity on `doc`, or `null`. */
export function hole_facts_of(doc: Document, identity: string): HoleFacts | null {
	let record = records.get(doc);
	if (record === undefined) {
		record = parse_record(doc);
		records.set(doc, record);
	}
	return record?.get(identity) ?? null;
}
