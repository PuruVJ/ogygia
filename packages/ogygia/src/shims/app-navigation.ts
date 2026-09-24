// Client-side shim for `$app/navigation` inside islands (and the body of `ogygia/app`).
//
// Two documents, one rule — the same one the `page` shims follow: on a Kit-booted document
// (csr=true), every call goes to Kit's REAL `$app/navigation`, published by the kit-page thread
// (`kit_bridge()`); on a document ogygia owns (csr=false), every call goes to the ogygia runtime's
// navigation handle — the SPA router's API, or the MPA handle under `router: false`. An island on a
// Kit page that called `goto()` used to reach the ogygia router, which does not own that document
// and could only fall back to a full load — a customer's green-band chips, rendered by a live island
// on the account page, reloaded the whole page on every click. Aliased only in the client build.
//
// ISLAND-SIDE CODE NEVER IMPORTS A RUNTIME MODULE: it reaches the runtime through the handle on
// `Symbol.for('ogygia.nav')` (runtime/nav-handle.ts). Importing the router here once made it — and
// everything its lazy chunks need — shared between island code and the runtime, which split the
// runtime's boot into a dozen files. Types only below.
import { kit_bridge } from './page-store.svelte.js';
import { bind_to_component } from '../runtime/nav-hooks.js';
import type { NavHandle } from '../runtime/nav-handle.js';
import type { BeforeNavigateCallback, AfterNavigateCallback } from '../runtime/router.js';

const kit = () => kit_bridge()?.navigation ?? null;
const og = () =>
	(globalThis as unknown as Record<symbol, NavHandle | undefined>)[Symbol.for('ogygia.nav')] ?? null;

/** No runtime on this document at all (neither Kit's nor ogygia's): the browser navigates. */
function browser_goto(url: string | URL, opts: { replaceState?: boolean; external?: boolean } = {}) {
	const target = new URL(url, location.href);
	if (target.protocol !== 'http:' && target.protocol !== 'https:') {
		throw new Error('[ogygia] goto() only supports http(s) URLs');
	}
	if (target.origin !== location.origin && !opts.external) {
		throw new Error('[ogygia] goto() only supports same-origin URLs (pass { external: true } to leave)');
	}
	if (opts.replaceState) location.replace(target.href);
	else location.assign(target.href);
	return Promise.resolve();
}
const NO_UNSUBSCRIBE = () => {};

export function goto(url: string | URL, opts?: { replaceState?: boolean; external?: boolean }): Promise<void> {
	const k = kit();
	if (k) return k.goto(url, opts);
	const o = og();
	return o ? o.goto(url, opts) : browser_goto(url, opts);
}

export function invalidate(resource?: unknown): Promise<void> {
	const k = kit();
	if (k) return k.invalidate(resource);
	const o = og();
	if (o) return o.invalidate();
	location.reload();
	return Promise.resolve();
}

export function invalidateAll(): Promise<void> {
	const k = kit();
	if (k) return k.invalidateAll();
	const o = og();
	if (o) return o.invalidateAll();
	location.reload();
	return Promise.resolve();
}

export function preloadData(url: string | URL): Promise<unknown> {
	const k = kit();
	if (k) return k.preloadData(url);
	const o = og();
	return o ? o.preloadData(url) : Promise.resolve({ type: 'loaded' as const, status: 200, data: {} });
}

export function preloadCode(url?: string): Promise<void> {
	const k = kit();
	if (k) return k.preloadCode(url);
	const o = og();
	return o ? o.preloadCode(url) : Promise.resolve();
}

export function pushState(url: string | URL, state: unknown): void {
	const k = kit();
	if (k) k.pushState(url, state);
	else og()?.pushState();
}

export function replaceState(url: string | URL, state: unknown): void {
	const k = kit();
	if (k) k.replaceState(url, state);
	else og()?.replaceState();
}

export function disableScrollHandling(): void {
	const k = kit();
	if (k) k.disableScrollHandling();
	else og()?.disableScrollHandling();
}

// Lifecycle-bound (unsubscribe on component destroy), like Kit's — Kit's own bind themselves.
export function beforeNavigate(fn: BeforeNavigateCallback): () => void {
	const k = kit();
	if (k) {
		k.beforeNavigate(fn as (navigation: unknown) => void);
		return NO_UNSUBSCRIBE;
	}
	return bind_to_component(og()?.beforeNavigate(fn) ?? NO_UNSUBSCRIBE);
}

export function afterNavigate(fn: AfterNavigateCallback): () => void {
	const k = kit();
	if (k) {
		k.afterNavigate(fn as (navigation: unknown) => void);
		return NO_UNSUBSCRIBE;
	}
	return bind_to_component(og()?.afterNavigate(fn) ?? NO_UNSUBSCRIBE);
}

// `onNavigate` (view-transition hook): Kit's on a Kit document; accept + no-op on ours (the ogygia
// router already handles view transitions).
export function onNavigate(fn: (navigation: unknown) => unknown): () => void {
	const k = kit();
	if (k) k.onNavigate(fn);
	return NO_UNSUBSCRIBE;
}

/** `ogygia/app`'s `bust_page_cache`: drop the SPA router's warmed page HTML (after mutations / auth
 *  changes). A no-op without the router — there is no page cache. */
export function bust_page_cache(): void {
	og()?.bust_page_cache();
}
