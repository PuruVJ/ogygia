/**
 * `beforeNavigate` / `afterNavigate` as a COMPONENT sees them (`$app/navigation`, `ogygia/app`):
 * lifecycle-bound like Kit's — the hook is unsubscribed when the calling component is destroyed.
 * The raw registrations in ./router.ts return an unsubscribe and nothing else; a component that
 * called them on every mount (an island re-mounting on each navigation) left one more callback
 * behind per visit. This module imports `onDestroy` from Svelte, so it lives beside the shims (in
 * an island's chunk, where Svelte already is) — never in the runtime's boot chunk.
 *
 * Outside a component (a plain module, a test) Svelte throws on `onDestroy`; the registration
 * still stands and the returned unsubscribe is the caller's to call, exactly as before.
 */
import { onDestroy } from 'svelte';
import {
	afterNavigate as after,
	beforeNavigate as before,
	type AfterNavigateCallback,
	type BeforeNavigateCallback
} from './router.js';

function bind(off: () => void): () => void {
	try {
		onDestroy(off);
	} catch {
		/* not inside a component — the caller owns the unsubscribe */
	}
	return off;
}

/** Register a callback before a client-side navigation; unsubscribed with the component. */
export function beforeNavigate(fn: BeforeNavigateCallback): () => void {
	return bind(before(fn));
}

/** Register a callback after a client-side navigation; unsubscribed with the component. */
export function afterNavigate(fn: AfterNavigateCallback): () => void {
	return bind(after(fn));
}
