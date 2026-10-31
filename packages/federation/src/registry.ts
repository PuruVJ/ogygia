/**
 * The process-wide federation slot. `federate()` registers the app's ONE identity here; the handle
 * (`/og/fragment/*`, `/og/thaw`, remote-region capabilities), the freeze registry (thaw notices on
 * invalidate) and the peers themselves read it back. `globalThis` + `Symbol.for` — the
 * PAGE-STATE-SINGLETON law (dist entries can double-evaluate a module); a second `federate()` call
 * (dev re-evaluation of the module that owns it) REPLACES the previous one.
 */
import type { Federation } from './types.js';

const SLOT = Symbol.for('ogygia.federation');

interface Slot {
	current: Federation | null;
}

const slot: Slot = ((globalThis as unknown as Record<symbol, Slot | undefined>)[SLOT] ??= {
	current: null
});

export function set_federation(f: Federation | null): void {
	slot.current = f;
}

export function current_federation(): Federation | null {
	return slot.current;
}
