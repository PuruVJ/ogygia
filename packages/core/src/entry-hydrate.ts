/**
 * THE FOREIGN-HYDRATE CONTRACT (fragment federation), in one place. A stitched fragment's island
 * entry may be woken by ANOTHER app's runtime. Svelte's hydrate/unmount carry module-level state
 * (hydration cursor, effect context), so the call must run against THIS build's svelte instance —
 * the consuming runtime only schedules and delegates. The hydration ENVELOPE is prepared here too:
 * anchor conventions belong to the svelte that compiled the entry, so the consumer never shapes them.
 * Same-origin wakes never call these.
 *
 * Every island entry of an app that federates re-exports these through `__og_hydrate` /
 * `__og_unmount` (compiler/region/emit.ts); an app that does not federate ships neither. This module
 * sits in the producer's own build, so its `svelte` is the producer's.
 *
 * Hydrate through THIS build's NestedProvider, mirroring the local runtime's call shape: the SSR
 * children were rendered through the provider's dynamic-component branch (the `<!--[0-->` marker), so
 * a bare-component hydrate walks one marker layer short — svelte aborts mid-walk and client-re-renders.
 * `options.recover === false`: the consumer's self-heal (hydrate-core.ts) asks THIS svelte to throw on
 * a mismatch instead of re-rendering; the envelope is re-checked per call because a restore from the
 * server markup drops it.
 */
import { hydrate, unmount, type Component } from 'svelte';
import NestedProvider from './NestedProvider.svelte';

export function og_entry_hydrate(component: Component<Record<string, unknown>>, target: Element, props: Record<string, unknown>, options?: { recover?: boolean }): unknown {
	const first = target.firstChild;
	if (!(first && first.nodeType === 8 && (first as Comment).data === '[')) {
		target.insertBefore(document.createComment('['), target.firstChild);
		target.appendChild(document.createComment(']'));
	}
	const recovery = options && options.recover === false ? { recover: false } : {};
	return hydrate(NestedProvider as unknown as Component<Record<string, unknown>>, { target, props: { component, props }, ...recovery });
}

export function og_entry_unmount(app: Record<string, unknown>): unknown {
	return unmount(app);
}
