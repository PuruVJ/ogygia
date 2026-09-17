// Client-side shim for `$app/navigation` inside islands (and the body of `ogygia/app`).
//
// Two documents, one rule — the same one the `page` shims follow: on a document ogygia owns
// (csr=false), every call goes to the ogygia SPA router; on a Kit-booted document (csr=true), every
// call goes to Kit's REAL `$app/navigation`, published by the kit-page thread (`kit_bridge()`). An
// island on a Kit page that called `goto()` used to reach the ogygia router, which does not own that
// document and could only fall back to a full load — a customer's green-band chips, rendered by a
// live island on the account page, reloaded the whole page on every click while the same `goto()`
// from Kit-hydrated cards navigated client-side. Aliased only in the client build.
import { kit_bridge } from './page-store.svelte.js';
import * as router from '../runtime/router.js';
import * as hooks from '../runtime/nav-hooks.js';
import type { BeforeNavigateCallback, AfterNavigateCallback } from '../runtime/router.js';

const kit = () => kit_bridge()?.navigation ?? null;

export function goto(url: string | URL, opts?: { replaceState?: boolean }): Promise<void> {
	const k = kit();
	return k ? k.goto(url, opts) : router.goto(url, opts);
}

export function invalidate(resource?: unknown): Promise<void> {
	const k = kit();
	return k ? k.invalidate(resource) : router.invalidate();
}

export function invalidateAll(): Promise<void> {
	const k = kit();
	return k ? k.invalidateAll() : router.invalidateAll();
}

export function preloadData(url: string | URL): Promise<unknown> {
	const k = kit();
	return k ? k.preloadData(url) : router.preloadData(url);
}

export function preloadCode(url?: string): Promise<void> {
	const k = kit();
	return k ? k.preloadCode(url) : router.preloadCode(url);
}

export function pushState(url: string | URL, state: unknown): void {
	const k = kit();
	if (k) k.pushState(url, state);
	else router.pushState();
}

export function replaceState(url: string | URL, state: unknown): void {
	const k = kit();
	if (k) k.replaceState(url, state);
	else router.replaceState();
}

export function disableScrollHandling(): void {
	const k = kit();
	if (k) k.disableScrollHandling();
	else router.disableScrollHandling();
}

// Lifecycle-bound (unsubscribe on component destroy), like Kit's — Kit's own bind themselves.
export function beforeNavigate(fn: BeforeNavigateCallback): () => void {
	const k = kit();
	if (k) {
		k.beforeNavigate(fn as (navigation: unknown) => void);
		return () => {};
	}
	return hooks.beforeNavigate(fn);
}

export function afterNavigate(fn: AfterNavigateCallback): () => void {
	const k = kit();
	if (k) {
		k.afterNavigate(fn as (navigation: unknown) => void);
		return () => {};
	}
	return hooks.afterNavigate(fn);
}

// `onNavigate` (view-transition hook): Kit's on a Kit document; accept + no-op on ours (the ogygia
// router already handles view transitions).
export function onNavigate(fn: (navigation: unknown) => unknown): () => void {
	const k = kit();
	if (k) k.onNavigate(fn);
	return () => {};
}
