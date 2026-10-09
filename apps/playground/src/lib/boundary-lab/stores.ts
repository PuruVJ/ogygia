/** BOUNDARY LAB — every store shape the boundary handles (and the two it can't fully). */
import { writable, derived, get } from 'svelte/store';

/** AUTO-BRANDED (provable factory): methods REBUILT on the island side — `bump()` works there. */
export const createTally = (seed = 0) => {
	const { subscribe, set, update } = writable(seed);
	return { subscribe, set, update, bump: () => update((n) => n + 1), read: () => get({ subscribe }) };
};

/** Plain writable: crosses automatically; all islands share ONE live instance. */
export const theme = () => writable<'dark' | 'light'>('dark');

/** LIMITATION 1 — a `derived` crosses as a FROZEN seed: the derivation itself cannot travel.
 *  Islands see the serialize-time value; later source writes do NOT update it. */
export const doubledOf = (src: { subscribe: (fn: (v: number) => void) => () => void }) =>
	derived(src, (n: number) => n * 2);

/** LIMITATION 2 — an UNBRANDED store with methods (built by a helper the compiler can't prove,
 *  no `og.store` assert): the VALUE crosses via the generic tier, `shout()` does NOT exist on
 *  the island side (the classifier warns naming it). */
export function makeUnprovable(seed: string) {
	const inner = writable(seed);
	const grafted = Object.assign({ subscribe: inner.subscribe, set: inner.set }, { shout: () => get(inner).toUpperCase() });
	return grafted;
}
