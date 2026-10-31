// Client-side shim for `$app/stores` ($page/$navigating) inside islands.
// Derives from the same shared $state.raw page store as `$app/state`, and re-runs each
// subscriber via the store's module-scoped subscriber set so `$page` updates after SPA navs.
// On a Kit-booted document the kit-world page thread supplies Kit's REAL page instead (the
// island store is never seeded there); the snapshot is read fresh per subscription — a static
// read, the same accepted trade-off as the shim's own url fallback (see e2e/split-brain.ts).
import { toStore, type Unsubscriber } from 'svelte/store';
import {
	page_state,
	subscribe_page,
	warn_foreign_page_read,
	type PageSnapshot
} from './page-store.svelte.ts';
import { kit_bridge } from './kit-bridge.ts';

function snapshot(): PageSnapshot {
	// A `$page` subscription reads every field — inside a mounted MFE island that is the SHELL's
	// page (dev warning, once per island; see `warn_foreign_page_read`).
	warn_foreign_page_read('$page');
	const bridged = kit_bridge()?.page ?? page_state;
	return {
		url: bridged.url,
		params: bridged.params,
		route: bridged.route,
		status: bridged.status,
		data: bridged.data,
		form: bridged.form,
		error: bridged.error,
		state: bridged.state
	};
}

type Snapshot = ReturnType<typeof snapshot>;

function same(a: Snapshot, b: Snapshot) {
	for (const k in a) if (a[k as keyof Snapshot] !== b[k as keyof Snapshot]) return false;
	return true;
}

export const page = {
	subscribe(run: (value: Snapshot) => void): () => void {
		// Kit world: a store over Kit's REAL reactive `page`, so the subscription stays live through
		// Kit navigations/invalidations (a plain snapshot would freeze at subscribe time). Built from
		// `$app/state`, not Kit's `$app/stores`: Kit 3 removed those (subscribing throws). A fresh
		// snapshot object is made per read, so an unchanged one is not passed on twice.
		if (kit_bridge()) {
			let last: Snapshot | null = null;
			return toStore(snapshot).subscribe((value) => {
				if (last && same(last, value)) return;
				last = value;
				run(value);
			});
		}
		run(snapshot());
		return subscribe_page(() => run(snapshot()));
	}
};

export const navigating = {
	subscribe(run: (value: unknown) => void): Unsubscriber {
		const kit = kit_bridge();
		if (kit) return toStore(() => kit.navigating.current ?? null).subscribe(run);
		run(null);
		return () => {};
	}
};

export const updated = {
	subscribe(run: (value: boolean) => void): () => void {
		run(false);
		return () => {};
	},
	check: async (): Promise<boolean> => false
};

/** Kit's `getStores()` (Kit 3 removed it; an island importing it still builds, and reads these). */
export const getStores = (): {
	page: typeof page;
	navigating: typeof navigating;
	updated: typeof updated;
} => ({ page, navigating, updated });
