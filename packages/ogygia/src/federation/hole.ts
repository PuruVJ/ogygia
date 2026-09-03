/**
 * A DEFERRED remote region — a hole the browser fetches from the SHELL's own handle, which derives
 * the visitor's claims at hole time and forwards to the peer. The hole URL is a shell-signed
 * capability (the browser can choose none of its inputs), so the v1 `proxy()` open-endpoint plus
 * its `widgets` allowlist are gone.
 *
 * The signer lives in the handle (it holds the region secret); this module is import-light and
 * client-safe, so it takes the signer through a `globalThis` + `Symbol.for` seam — the
 * PAGE-STATE-SINGLETON law. On the client (or a server with no federation handle) the seam is
 * unset and the mint degrades to an empty inert region rather than throwing.
 */
import { REGION_BRAND } from '../region-brand.js';
import type { DeferredRegion } from '../region.js';
import type { Claims } from './wire.js';

/** What the handle installs: sign a hole and return its fetch URL, or null if it cannot. */
export type HoleSigner = (spec: {
	peer: string;
	kind: 'page' | 'widget';
	target: string;
	search: string;
	claims?: Claims;
}) => string | null;

interface HoleSlot {
	signer: HoleSigner | null;
}
const SLOT = Symbol.for('ogygia.federation.hole');
const slot: HoleSlot = ((globalThis as unknown as Record<symbol, HoleSlot | undefined>)[SLOT] ??= {
	signer: null
});

/** hooks.ts installs the signer once (it holds the region secret). */
export function set_hole_signer(fn: HoleSigner | null): void {
	slot.signer = fn;
}

/** Build a deferred remote-region value. `target` is the peer path (page) or widget name. */
export function mint_hole(
	peer: string,
	kind: 'page' | 'widget',
	target: string,
	search: string,
	claims?: Claims
): DeferredRegion {
	const url = slot.signer?.({ peer, kind, target, search, claims }) ?? '';
	return {
		[REGION_BRAND]: true,
		kind: 'deferred',
		id: `frag:${peer}:${target}`,
		props: {},
		url,
		// A remote fragment brings its OWN islands (they wake themselves once the HTML swaps in);
		// the hole itself is HTML-only, so no hydrate module of its own.
		module: ''
	};
}
