// Client-side shim for `$app/stores` ($page/$navigating) inside islands.
// Derives from the same shared $state.raw page store as `$app/state`, and re-runs each
// subscriber via the store's module-scoped subscriber set so `$page` updates after SPA navs.
// On a Kit-booted document the kit-world page thread supplies Kit's REAL page instead (the
// island store is never seeded there); the snapshot is read fresh per subscription — a static
// read, the same accepted trade-off as the shim's own url fallback (see e2e/split-brain.ts).
import { page_state, subscribe_page, kit_bridge } from './page-store.svelte.js';

function snapshot() {
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

export const page = {
	subscribe(run: (value: ReturnType<typeof snapshot>) => void) {
		// Kit world: delegate to Kit's REAL `$page` store — identical value shape, and the
		// subscription stays live through Kit navigations/invalidations (a fallback snapshot
		// would freeze at subscribe time there).
		const real = kit_bridge()?.page_store;
		if (real) return real.subscribe(run);
		run(snapshot());
		return subscribe_page(() => run(snapshot()));
	}
};

export const navigating = {
	subscribe(run: (value: unknown) => void) {
		run(kit_bridge()?.navigating.current ?? null);
		return () => {};
	}
};

export const updated = {
	subscribe(run: (value: boolean) => void) {
		run(false);
		return () => {};
	},
	check: async () => false
};
