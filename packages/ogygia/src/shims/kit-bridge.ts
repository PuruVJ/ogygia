/**
 * KIT-WORLD PAGE THREAD (read side). On a Kit-booted (csr=true) document the ogygia runtime never
 * runs, so nothing ever seeds the island page store — a module SHARED between an island and a Kit page
 * then read `data: {}` through the shims, and a real app's `page.data._locale.toLowerCase()` in onMount
 * threw inside Kit's synchronous hydrate flush, killing every mount after it. The fix is a thread
 * between the two worlds: two lines appended to Kit's generated client app entry (see KIT_PAGE_THREAD
 * in vite/index.ts) publish Kit's REAL reactive `page` and navigation on this well-known symbol, and the
 * shims prefer it whenever it exists. Kit's entry evaluates exactly when Kit boots and never ships to
 * csr=false pages — so on csr=false documents the symbol is never set and the seeded shim path is
 * untouched.
 *
 * A plain module, no runes: what only needs the thread (`ogygia/app`'s navigation, `$app/navigation`)
 * must load anywhere — in plain node too — without the reactive page store (page-store.svelte.ts).
 */
import type { PageSnapshot } from './page-store.svelte.js';

/** Kit's real `$app/navigation`, as published by the thread — the `$app/navigation` shim (and
 *  `ogygia/app`) delegate every call here on a Kit-booted document. Typed loosely on purpose: the
 *  shim forwards arguments as given; Kit's own types apply at the call site. */
export interface KitNavigation {
	goto(url: string | URL, opts?: unknown): Promise<void>;
	invalidate(resource?: unknown): Promise<void>;
	invalidateAll(): Promise<void>;
	refreshAll(): Promise<void>;
	preloadData(url: string | URL): Promise<unknown>;
	preloadCode(url?: string): Promise<void>;
	pushState(url: string | URL, state: unknown): void;
	replaceState(url: string | URL, state: unknown): void;
	disableScrollHandling(): void;
	beforeNavigate(callback: (navigation: unknown) => void): void;
	afterNavigate(callback: (navigation: unknown) => void): void;
	onNavigate(callback: (navigation: unknown) => unknown): void;
	snapshot(options: { id?: string; capture: () => unknown; restore: (value: never) => void; reset?: () => void }): void;
}

/** Kit's `navigating` from `$app/state`: every field null when no navigation is in flight. */
export interface KitNavigating {
	from: unknown;
	to: { url: URL } | null;
	type: string | null;
	willUnload: boolean | null;
	delta: number | null;
	complete: Promise<void> | null;
}

export interface KitPageBridge {
	page: PageSnapshot;
	navigating: KitNavigating;
	/** Kit's real navigation module (see {@link KitNavigation}). */
	navigation: KitNavigation;
}

const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');

/** The thread Kit published on this document, or null (a csr=false document, or before Kit boots). */
export function kit_bridge(): KitPageBridge | null {
	return (globalThis as unknown as Record<symbol, KitPageBridge | undefined>)[KIT_PAGE_KEY] ?? null;
}
