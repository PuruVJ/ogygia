/**
 * Client side of streaming server islands. When a page streams (`<meta name="ogygia-stream">`), its
 * deferred `when="load"` holes arrive as `<template data-ogygia-slot>` parcels appended after the
 * document. This singleton collects parcels (a boot sweep for ones already present + a
 * MutationObserver for ones still in flight) and hands each region its HTML by slot key. A region
 * that is never streamed a parcel (stream ended, or the page does not stream) falls back to the
 * normal per-hole fetch — so streaming is a pure optimization.
 */
import { slots } from './slots.js';
import { STREAM_DONE_SLOT } from '../server/stream-regions.js';

type Waiter = (html: string | null) => void;

class StreamSlots {
	#active: boolean | null = null;
	#done = false;
	#started = false;
	/** Parcels that arrived before their region asked for them. */
	#pending = new Map<string, string>();
	/** Regions waiting for a parcel that has not arrived yet. */
	#waiters = new Map<string, Waiter>();
	#observer: MutationObserver | null = null;
	/** Templates already consumed (guard against the observe/sweep overlap double-ingesting one). */
	#ingested = new WeakSet<Element>();

	/** True when the current document declared itself a streamed page. Cached. */
	get active(): boolean {
		if (this.#active === null) {
			this.#active =
				typeof document !== 'undefined' &&
				!!document.querySelector('meta[name="ogygia-stream"]');
		}
		return this.#active;
	}

	/** Observe + sweep for parcels (idempotent). Call before regions start waiting. */
	start(): void {
		if (this.#started || typeof document === 'undefined') return;
		this.#started = true;
		// Observe FIRST so a parcel added during the sweep is not missed; `#ingested` de-dupes any
		// node that is both observed and swept.
		this.#observer = new MutationObserver((records) => {
			for (const rec of records) {
				for (const node of Array.from(rec.addedNodes)) {
					if (node instanceof HTMLTemplateElement && node.hasAttribute('data-ogygia-slot')) {
						this.#ingest(node);
					}
				}
			}
		});
		this.#observer.observe(document.documentElement, { childList: true, subtree: true });
		for (const tpl of Array.from(document.querySelectorAll('template[data-ogygia-slot]'))) {
			this.#ingest(tpl as HTMLTemplateElement);
		}
	}

	#ingest(tpl: HTMLTemplateElement): void {
		if (this.#ingested.has(tpl)) return;
		this.#ingested.add(tpl);
		const slot = tpl.getAttribute('data-ogygia-slot') || '';
		if (slot === STREAM_DONE_SLOT) {
			tpl.remove();
			this.#finish();
			return;
		}
		const html = tpl.innerHTML;
		tpl.remove();
		const waiter = this.#waiters.get(slot);
		if (waiter) {
			this.#waiters.delete(slot);
			waiter(html);
		} else {
			this.#pending.set(slot, html);
		}
	}

	#finish(): void {
		if (this.#done) return;
		this.#done = true;
		this.#observer?.disconnect();
		this.#observer = null;
		// Stream over — release every still-waiting region to its fetch fallback.
		for (const waiter of this.#waiters.values()) waiter(null);
		this.#waiters.clear();
	}

	/**
	 * Resolve with a parcel's HTML for `slot`, or `null` once the stream is done (→ fetch fallback).
	 * Resolves immediately if the parcel already arrived or the stream already finished.
	 */
	wait(slot: string): Promise<string | null> {
		const pending = this.#pending.get(slot);
		if (pending !== undefined) {
			this.#pending.delete(slot);
			return Promise.resolve(pending);
		}
		if (this.#done) return Promise.resolve(null);
		return new Promise((resolve) => this.#waiters.set(slot, resolve));
	}
}

export const stream_slots = new StreamSlots();

/** Feature entry: fill the `stream` slot. Core starts it (before the CE upgrades) if it's active. */
export function install() {
	slots.stream = stream_slots;
}
