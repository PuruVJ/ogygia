/**
 * Shared request FACTS — the only state plugins share with core and with each other. A fact is
 * filled by whoever learns it and read by whoever needs it; neither side imports the other.
 *
 * The state sits on ONE global slot, not module scope: a plugin package and core can end up as two
 * module instances of this file (a workspace link, a dual install, src beside dist), and a fact
 * written through one must be read through the other.
 */
interface FactsSlot {
	personal_sink: ((label: string) => void) | null;
	assigned: WeakMap<Request, Record<string, string>>;
}
const slot: FactsSlot = ((globalThis as Record<symbol, FactsSlot | undefined>)[Symbol.for('ogygia.facts.v1')] ??= {
	personal_sink: null,
	assigned: new WeakMap()
});

/** Core only (hooks.ts): where a personal read lands for the current request. */
export function set_personal_read_sink(fn: ((label: string) => void) | null): void {
	slot.personal_sink = fn;
}

/** This render read something that differs per visitor (a flag decision), named for the dev note
 *  (`flag:hero`). A page that did must never be stored and served to everyone — the freeze verdict
 *  reads it. Safe in any bundle: on the client, or outside a page render, it is a no-op. */
export function personal_read(label: string): void {
	slot.personal_sink?.(label);
}

/** A flag decided `variant` for this request (flags write it on every read). */
export function note_assignment(request: Request, name: string, variant: string): void {
	let map = slot.assigned.get(request);
	if (!map) slot.assigned.set(request, (map = {}));
	map[name] = variant;
}

/** Every (flag → variant) this request decided so far — federation carries it as signed claims. */
export function assignments(request: Request): Record<string, string> | undefined {
	return slot.assigned.get(request);
}
