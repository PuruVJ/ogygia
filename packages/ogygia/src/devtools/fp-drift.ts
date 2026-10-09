/**
 * ISLANDS WHOSE FINGERPRINT MOVES BETWEEN TWO LOADS OF THE SAME PAGE. An island's `data-og-fp` is
 * the hash of its props: what the router compares to keep a live island across a navigation, and
 * part of the page's bytes (a host's post-render cache, a freeze store, an ETag key on them). A prop
 * made fresh on every render — a time, a random id — moves it every time, so the island is patched on
 * every navigation and every such cache misses. ogygia's own ids are stable now; this finds the
 * app's.
 *
 * Per tab (sessionStorage): each page's islands as last loaded — entry, fingerprint, props text.
 * On the next load of the same page (or an in-app navigation back to it), each island is matched by
 * its entry and its place among copies of it; a moved fingerprint is named with the prop that
 * differs (the first differing path on the JSON lane, else the first differing text).
 *
 * PURE (no DOM): the devtools record each load (page.ts `fp_drift`), the profiler compares its own
 * renders of a page (report.ts) — one comparison, one rule.
 */
import { unflatten } from 'devalue';

export interface FpDrift {
	entry: string;
	fp_was: string;
	fp_now: string;
	/** the first differing path in the props (`stamp`, `items[2].id`), when the props parse */
	path?: string;
	/** the values there, clipped (or the text around the first difference) */
	was?: string;
	now?: string;
}

/** One island as one load (or render) had it. */
export interface KeptIsland {
	entry: string;
	fp: string;
	props?: string;
}
type Kept = KeptIsland;

/** Islands matched by entry and their place among its copies; a moved fingerprint, explained. */
export function compare(was: Kept[], now: Kept[]): FpDrift[] {
	const nth = (list: Kept[]) => {
		const seen = new Map<string, number>();
		return list.map((k) => {
			const n = seen.get(k.entry) ?? 0;
			seen.set(k.entry, n + 1);
			return `${k.entry}#${n}`;
		});
	};
	const before = new Map(nth(was).map((key, i) => [key, was[i]]));
	const out: FpDrift[] = [];
	const keys = nth(now);
	for (let i = 0; i < now.length; i++) {
		const a = before.get(keys[i]);
		const b = now[i];
		if (!a || a.fp === b.fp) continue;
		if (a.props !== undefined && b.props !== undefined) {
			const d = props_diff(a.props, b.props);
			// (only ogygia's own ids differ: a store or a class instance, made per render on purpose —
			// a reused id could revive the wrong page's instance after a navigation. Not the app's to fix.)
			if (!d) continue;
			out.push({ entry: b.entry, fp_was: a.fp, fp_now: b.fp, ...d });
		} else out.push({ entry: b.entry, fp_was: a.fp, fp_now: b.fp });
	}
	return out;
}

/** Where two props texts differ: the first differing path when both parse as JSON, else the text
 *  around the first differing character — ogygia's own ids (a store's, a class instance's: random
 *  per render by design) left out. `null` when those ids are all that differs. */
export function props_diff(a: string, b: string): { path?: string; was?: string; now?: string } | null {
	if (a === b) return null;
	try {
		return first_path(revive(JSON.parse(a)), revive(JSON.parse(b)), '');
	} catch {
		/* neither lane parsed: the text, with the ids masked */
	}
	const ma = mask_ids(a);
	const mb = mask_ids(b);
	if (ma === mb) return null;
	let i = 0;
	while (i < ma.length && i < mb.length && ma.charCodeAt(i) === mb.charCodeAt(i)) i++;
	const from = Math.max(0, i - 20);
	return { was: ma.slice(from, i + 40), now: mb.slice(from, i + 40) };
}

/**
 * The props as values, for naming a path. Props are an object, so a parsed ARRAY is the devalue
 * lane's flat table — `[7]` would name a slot, not a prop: unflattened back into the props, every
 * custom type (a transportable, a ref) kept as `{ "<type>": value }` (any reviver, so none throws).
 */
function revive(parsed: unknown): unknown {
	return Array.isArray(parsed) ? unflatten(parsed, ANY_REVIVER) : parsed;
}

const keep_typed = (type: string) => (value: unknown) => ({ [`<${type}>`]: value });
/** A revivers table that has every type (devalue asks `Object.hasOwn`, then calls it). */
const ANY_REVIVER = new Proxy({} as Record<string, (v: unknown) => unknown>, {
	getOwnPropertyDescriptor: (_, k) => ({ value: keep_typed(String(k)), configurable: true, enumerable: true, writable: false }),
	get: (_, k) => keep_typed(String(k))
});

/** ogygia's mint id: a UUID (`8-4-4-4-12` hex). */
function is_mint_id(v: unknown): boolean {
	if (typeof v !== 'string' || v.length !== 36) return false;
	for (let i = 0; i < 36; i++) {
		const c = v.charCodeAt(i);
		if (i === 8 || i === 13 || i === 18 || i === 23) {
			if (c !== 45) return false;
		} else if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
	}
	return true;
}

/** The text with every UUID replaced by a fixed one (for the non-JSON compare). */
function mask_ids(s: string): string {
	let out = '';
	let last = 0;
	for (let i = 0; i + 36 <= s.length; i++) {
		if (s.charCodeAt(i + 8) !== 45 || !is_mint_id(s.slice(i, i + 36))) continue;
		out += s.slice(last, i) + '<id>';
		last = i + 36;
		i += 35;
	}
	return last === 0 ? s : out + s.slice(last);
}

function first_path(a: unknown, b: unknown, path: string): { path: string; was: string; now: string } | null {
	if (a === b) return null;
	if (is_mint_id(a) && is_mint_id(b)) return null;
	const clip = (v: unknown) => {
		const s = JSON.stringify(v) ?? String(v);
		return s.length > 60 ? s.slice(0, 60) + '…' : s;
	};
	if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
		if (Array.isArray(a)) {
			const bb = b as unknown[];
			for (let i = 0; i < Math.max(a.length, bb.length); i++) {
				const d = first_path(a[i], bb[i], `${path}[${i}]`);
				if (d) return d;
			}
			return null;
		}
		const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
		for (const k of keys) {
			const d = first_path((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
			if (d) return d;
		}
		return null;
	}
	return { path: tidy_path(path) || '(the props)', was: clip(a), now: clip(b) };
}

/** A path as the author wrote the props: ogygia's own ref wrapper (a store, a shared class — the
 *  value inside it is `.d`) left out, so `cart.<OgygiaRef>.d.serverStamp` reads `cart.serverStamp`. */
function tidy_path(path: string): string {
	return path.split('.<OgygiaRef>.d').join('').split('.<OgygiaRef>').join('');
}
