/**
 * `beforeNavigate` / `afterNavigate` as a COMPONENT sees them (`$app/navigation`, `ogygia/app`):
 * lifecycle-bound like Kit's — the hook is unsubscribed when the calling component is destroyed.
 * The raw registrations (the runtime's navigation handle, ./nav-handle.ts) return an unsubscribe and
 * nothing else; a component that called them on every mount (an island re-mounting on each
 * navigation) left one more callback behind per visit. This module imports `onDestroy` from Svelte,
 * so it lives beside the shims (in an island's chunk, where Svelte already is) — never in the
 * runtime's boot chunk — and it imports nothing from the runtime (island code reaches it only
 * through the navigation handle).
 *
 * Outside a component (a plain module, a test) Svelte throws on `onDestroy`; the registration
 * still stands and the returned unsubscribe is the caller's to call, exactly as before.
 */
import { onDestroy } from 'svelte';

/** Tie a registration's unsubscribe to the calling component's lifetime; returns it too. */
export function bind_to_component(off: () => void): () => void {
	try {
		onDestroy(off);
	} catch {
		/* not inside a component — the caller owns the unsubscribe */
	}
	return off;
}
