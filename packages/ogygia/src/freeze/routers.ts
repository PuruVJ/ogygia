/**
 * FREEZE × the programmatic router — the registry a mounted `routes()` table joins so the handle
 * can ask "is this pathname a frozen page?" for requests Kit's FILE router never claimed
 * (`event.route.id` is null under `sequence(ogygiaHandle(), app.handle)`, and a catch-all
 * `+server.ts` forwarding to `app.fetch` is an endpoint route, not a page).
 *
 * Verdict grammar, per matcher: `undefined` = not mine (ask the next router, then the file
 * world) · `null` = mine, but nothing declared `freeze` (page/layout/table) → the handle applies
 * the config `default` · `boolean` = mine, declared (page > innermost layout > … > table).
 *
 * Keyed, not appended: dev re-evaluates hooks.server.ts and calls `routes()` again — a matcher
 * with the same key (base + pattern list) REPLACES its stale twin instead of shadowing it.
 * Symbol.for slot: dist entries can double-evaluate a module (PAGE-STATE-SINGLETON law), so the
 * registry lives on globalThis, one per process, not one per module copy.
 */

export type FreezeVerdict = boolean | null | undefined;
export type FreezeMatcher = (pathname: string) => FreezeVerdict;

const SLOT = Symbol.for('ogygia.freeze-routers');

function registry(): Map<string, FreezeMatcher> {
	const g = globalThis as unknown as Record<symbol, Map<string, FreezeMatcher> | undefined>;
	return (g[SLOT] ??= new Map());
}

/** A `routes()` table joins the registry (replacing a same-key predecessor). */
export function register_freeze_router(key: string, matcher: FreezeMatcher): void {
	const r = registry();
	r.delete(key); // re-insert at the END so a replaced table keeps its relative order simple
	r.set(key, matcher);
}

/** First mounted router that CLAIMS the pathname decides; `undefined` when none does. */
export function router_freeze_verdict(pathname: string): FreezeVerdict {
	for (const matcher of registry().values()) {
		const v = matcher(pathname);
		if (v !== undefined) return v;
	}
	return undefined;
}

/** Tests only. */
export function clear_freeze_routers(): void {
	registry().clear();
}
