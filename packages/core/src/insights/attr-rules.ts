/**
 * Attribute changes a test chooses to leave out of the hydration report (`ignoreAttributes`): by the
 * element's tag, the attribute's name and its new value (the old one when it was removed). Rules cross
 * from the test as plain data — a string matches exactly, `{ re, flags }` is a RegExp.
 */
import type { AttrChange } from '../runtime/beacon.ts';

export type Pat = string | { re: string; flags?: string };
export interface AttrRule {
	tag?: Pat;
	name: Pat;
	value?: Pat;
}

function matcher(p: Pat | undefined): (s: string | null) => boolean {
	if (p === undefined) return () => true;
	if (typeof p === 'string') return (s) => s === p;
	const re = new RegExp(p.re, p.flags);
	return (s) => s !== null && re.test(s);
}

/** Split `changes` into those `rules` ignore and those left. */
export function apply_attr_rules(
	changes: AttrChange[],
	rules: AttrRule[]
): { left: AttrChange[]; ignored: AttrChange[] } {
	if (!rules.length) return { left: changes, ignored: [] };
	const ms = rules.map((r) => ({
		tag: matcher(r.tag),
		name: matcher(r.name),
		value: matcher(r.value)
	}));
	const left: AttrChange[] = [];
	const ignored: AttrChange[] = [];
	for (const c of changes)
		(ms.some((m) => m.tag(c.tag) && m.name(c.name) && m.value(c.to ?? c.from))
			? ignored
			: left
		).push(c);
	return { left, ignored };
}
