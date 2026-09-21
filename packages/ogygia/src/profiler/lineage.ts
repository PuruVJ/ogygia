/**
 * DATA LINEAGE FROM THE CODE — which `page.data` keys each component actually reads, joined to
 * the loads that produced them and the seed that shipped them. The river (river.ts) draws the
 * flow with the islands' keys from the build; this reads the SERVER components' sources too, so
 * every key gets a verdict: read by an island (must ship), read on the server only (rendered
 * into HTML, need not ship), read by nobody (fetched for nothing — the load's wait behind it is
 * pure waste), or unknown (a component's reads could not be told).
 *
 * The scanner is a character walk, no regex: `data.key`, `data['key']`, `page.data.key`,
 * `$page.data.key`, and the destructurings `const { a, b: c } = data` / `= page.data`.
 */

const is_ident_start = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const is_ident = (c: number) => is_ident_start(c) || (c >= 48 && c <= 57);
const is_space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** the identifier ending right before `end` (exclusive), or '' */
function ident_before(src: string, end: number): string {
	let i = end;
	while (i > 0 && is_ident(src.charCodeAt(i - 1))) i--;
	return src.slice(i, end);
}

/** the identifier starting at `i`, or '' */
function ident_at(src: string, i: number): string {
	if (i >= src.length || !is_ident_start(src.charCodeAt(i))) return '';
	let j = i + 1;
	while (j < src.length && is_ident(src.charCodeAt(j))) j++;
	return src.slice(i, j);
}

/** the keys of a destructuring pattern `{ a, b: c, d = 1, ...rest }` given the index of its `{` */
function pattern_keys(src: string, open: number, out: Set<string>): void {
	let depth = 0;
	let i = open;
	let key_start = -1;
	let took = false;
	for (; i < src.length; i++) {
		const c = src.charCodeAt(i);
		if (c === 123 /* { */ || c === 91 /* [ */ || c === 40 /* ( */) {
			depth++;
			if (depth === 1) {
				key_start = -1;
				took = false;
			}
			continue;
		}
		if (c === 125 /* } */ || c === 93 /* ] */ || c === 41 /* ) */) {
			depth--;
			if (depth === 0) {
				if (key_start >= 0 && !took) out.add(src.slice(key_start, i).trim());
				return;
			}
			continue;
		}
		if (depth !== 1) continue;
		if (c === 44 /* , */) {
			if (key_start >= 0 && !took) out.add(src.slice(key_start, i).trim());
			key_start = -1;
			took = false;
			continue;
		}
		if (c === 58 /* : */ || c === 61 /* = */) {
			if (key_start >= 0 && !took) out.add(src.slice(key_start, i).trim());
			took = true;
			continue;
		}
		if (key_start < 0 && !took && is_ident_start(c)) {
			// `...rest` takes every key: not a name
			if (src.charCodeAt(i - 1) === 46) {
				took = true;
				continue;
			}
			key_start = i;
		}
	}
}

/**
 * The `page.data` keys a component source reads, or `null` when it takes the whole object in a
 * way that cannot be named (`...data`, `data` passed on, `Object.keys(data)`). `names` are the
 * identifiers that hold the data (`data` by default; `page.data` / `$page.data` always count).
 */
export function data_reads(source: string, names: readonly string[] = ['data']): string[] | null {
	const src = blank_comments(source);
	const keys = new Set<string>();
	let whole = false;
	const seen = new Set<string>();
	for (const name of ['data', ...names]) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (scan(src, name, names.includes(name), keys)) whole = true;
	}
	if (whole && !keys.size) return null;
	if (whole) return [...keys, '*'];
	return [...keys];
}

/** The source with its comments (`//`, block, HTML) and string contents blanked to spaces, so
 *  a word in prose or a URL never reads as code; positions are kept. A character walk. */
export function blank_comments(src: string): string {
	const out = src.split('');
	const n = src.length;
	let i = 0;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
	};
	while (i < n) {
		const c = src.charCodeAt(i);
		const next = src.charCodeAt(i + 1);
		if (c === 47 /* / */ && next === 47) {
			let e = src.indexOf('\n', i);
			if (e === -1) e = n;
			blank(i, e);
			i = e;
			continue;
		}
		if (c === 47 && next === 42 /* * */) {
			let e = src.indexOf('*/', i + 2);
			e = e === -1 ? n : e + 2;
			blank(i, e);
			i = e;
			continue;
		}
		if (c === 60 /* < */ && src.startsWith('<!--', i)) {
			let e = src.indexOf('-->', i + 4);
			e = e === -1 ? n : e + 3;
			blank(i, e);
			i = e;
			continue;
		}
		if (c === 39 || c === 34 || c === 96) {
			// a string: keep the quotes, blank the inside (a template's `${}` holes stay code)
			let e = i + 1;
			while (e < n) {
				const d = src.charCodeAt(e);
				if (d === 92 /* \ */) {
					e += 2;
					continue;
				}
				if (d === c) break;
				if (c === 96 && d === 36 && src.charCodeAt(e + 1) === 123) {
					// `${` … `}` — leave the expression as code
					let depth = 1;
					let k = e + 2;
					while (k < n && depth) {
						const q = src.charCodeAt(k);
						if (q === 123) depth++;
						else if (q === 125) depth--;
						k++;
					}
					e = k;
					continue;
				}
				if (c !== 96 && d === 10) break;
				e++;
			}
			// keep the quoted text of a key access (`data['key']`) readable: only blank prose-like
			// strings, which are longer than a key or hold a space
			const inner = src.slice(i + 1, e);
			if (inner.includes(' ') || inner.length > 40) blank(i + 1, e);
			i = e + 1;
			continue;
		}
		i++;
	}
	return out.join('');
}

/** one name's occurrences; returns true when the object was used whole somewhere */
function scan(src: string, name: string, bare_ok: boolean, keys: Set<string>): boolean {
	let whole = false;
	const n = src.length;
	const len = name.length;
	let i = 0;
	while (i < n) {
		const j = src.indexOf(name, i);
		if (j === -1) break;
		i = j + len;
		// a whole identifier (not `metadata`, not `dataset`)
		if (j > 0 && is_ident(src.charCodeAt(j - 1))) continue;
		if (i < n && is_ident(src.charCodeAt(i))) continue;
		// a spread (`...data`): every key may be read
		if (j >= 3 && src.charCodeAt(j - 1) === 46 && src.charCodeAt(j - 2) === 46 && src.charCodeAt(j - 3) === 46) {
			if (bare_ok) whole = true;
			continue;
		}
		// whose: bare (a data prop name), or `page.data` / `$page.data`
		let owner = '';
		if (j > 0 && src.charCodeAt(j - 1) === 46 /* . */) {
			owner = ident_before(src, j - 1);
			if (name !== 'data' || (owner !== 'page' && owner !== '$page')) continue;
		} else if (!bare_ok) continue;
		// what follows
		let k = i;
		while (k < n && is_space(src.charCodeAt(k))) k++;
		const c = src.charCodeAt(k);
		if (c === 46 /* . */) {
			const key = ident_at(src, k + 1);
			if (key) keys.add(key);
			continue;
		}
		if (c === 91 /* [ */) {
			let q = k + 1;
			while (q < n && is_space(src.charCodeAt(q))) q++;
			const quote = src.charCodeAt(q);
			if (quote === 39 || quote === 34 || quote === 96) {
				const close = src.indexOf(src[q], q + 1);
				if (close > q) keys.add(src.slice(q + 1, close));
			} else whole = true;
			continue;
		}
		// `= data` after a destructuring pattern: walk back over `=` and spaces to the `}`
		let b = j - 1;
		if (owner) b -= owner.length + 1;
		while (b >= 0 && is_space(src.charCodeAt(b))) b--;
		if (b >= 0 && src.charCodeAt(b) === 61 /* = */) {
			let e = b - 1;
			while (e >= 0 && is_space(src.charCodeAt(e))) e--;
			if (e >= 0 && src.charCodeAt(e) === 125 /* } */) {
				// find the matching `{`
				let depth = 0;
				let o = e;
				for (; o >= 0; o--) {
					const cc = src.charCodeAt(o);
					if (cc === 125) depth++;
					else if (cc === 123 && --depth === 0) break;
				}
				if (o >= 0) {
					pattern_keys(src, o, keys);
					continue;
				}
			}
			// `const alias = data` / `x = data`: the whole object under another name
			if (c === 59 /* ; */ || c === 10 || k >= n) {
				whole = true;
				continue;
			}
		}
		// the object itself, handed on whole — passed to a call (`fn(data)`), returned, put in
		// an array, defaulted (`data ?? {}`) — every key may be read past this point
		if (c === 41 /* ) */ || c === 93 /* ] */ || c === 63 /* ? */ || c === 124 /* | */ || c === 38 /* & */) {
			whole = true;
			continue;
		}
		// everything else is not a read of the data: a pattern member (`let { data } = …`), a
		// hand-off to a child that is scanned on its own (`<Child {data} />`), an attribute
		// (`data-x`, `data={…}`), a path (`'$lib/data'`), a word in prose
	}
	return whole;
}

/** the `let { data } = $props()` / `export let data` names a component gives its data prop —
 *  plus any rename (`let { data: page_data } = $props()`) */
export function data_prop_names(src: string): string[] {
	const names = new Set<string>(['data']);
	const at = src.indexOf('$props()');
	if (at !== -1) {
		let e = at - 1;
		while (e >= 0 && is_space(src.charCodeAt(e))) e--;
		if (e >= 0 && src.charCodeAt(e) === 61) {
			e--;
			while (e >= 0 && is_space(src.charCodeAt(e))) e--;
			if (e >= 0 && src.charCodeAt(e) === 125) {
				let depth = 0;
				let o = e;
				for (; o >= 0; o--) {
					const cc = src.charCodeAt(o);
					if (cc === 125) depth++;
					else if (cc === 123 && --depth === 0) break;
				}
				if (o >= 0) {
					// `data: alias` inside the pattern
					const body = src.slice(o, e + 1);
					const d = body.indexOf('data');
					if (d !== -1) {
						let q = d + 4;
						while (q < body.length && is_space(body.charCodeAt(q))) q++;
						if (body.charCodeAt(q) === 58) {
							q++;
							while (q < body.length && is_space(body.charCodeAt(q))) q++;
							const alias = ident_at(body, q);
							if (alias) names.add(alias);
						}
					}
				}
			}
		}
	}
	return [...names];
}

// ── the join ─────────────────────────────────────────────────────────────────────────────────

/** `island`: an island names it (must ship) · `server`: read on the server, not shipped (fine) ·
 *  `server-only`: read on the server only, yet shipped · `unread`: nobody reads it · `unknown`:
 *  a reader could not be scanned, or an island takes the page whole */
export type KeyVerdict = 'island' | 'server' | 'server-only' | 'unread' | 'unknown';

export interface LineageKey {
	key: string;
	/** the load file that returns it, when its source said */
	from: string | null;
	/** bytes the seed shipped for it (0: not shipped) */
	shipped_bytes: number;
	/** who reads it */
	readers: { name: string; island: boolean }[];
	verdict: KeyVerdict;
	/** the waiting the load that produced it did (its upstream calls), when known */
	load_wait_ms: number | null;
}

export interface LineageComponent {
	name: string;
	file: string;
	island: boolean;
	/** the keys it reads; null when it could not be told */
	reads: string[] | null;
	/** it reads the whole object (a spread, a pass-through): every key may be read */
	whole: boolean;
}

export interface Lineage {
	keys: LineageKey[];
	components: LineageComponent[];
	/** keys nobody reads, by the wait behind them */
	unread: LineageKey[];
	/** keys shipped in the seed but read only on the server */
	server_only: LineageKey[];
	notes: string[];
}

export interface LineageInput {
	/** every component of the page with its reads (server components scanned; islands from the build) */
	components: { name: string; file: string; island: boolean; reads: string[] | null }[];
	/** the loads and the keys they return, plus the waiting each did */
	lanes: { file: string; keys: string[] | null; wait_ms?: number }[];
	/** bytes per key in the seed */
	seed: Record<string, number>;
}

export function build_lineage(input: LineageInput): Lineage | undefined {
	const notes: string[] = [];
	const components: LineageComponent[] = input.components.map((c) => {
		const whole = c.reads?.includes('*') ?? false;
		return { name: c.name, file: c.file, island: c.island, reads: c.reads ? c.reads.filter((k) => k !== '*') : null, whole };
	});
	// the universe of keys: what loads return, what the seed ships, what anyone reads
	const from = new Map<string, string>();
	const wait = new Map<string, number>();
	let any_lane = false;
	for (const l of input.lanes) {
		if (!l.keys) continue;
		any_lane = true;
		for (const k of l.keys) {
			if (!from.has(k)) from.set(k, l.file);
			if (l.wait_ms !== undefined) wait.set(k, l.wait_ms);
		}
	}
	const keys = new Set<string>([...from.keys(), ...Object.keys(input.seed)]);
	for (const c of components) for (const k of c.reads ?? []) keys.add(k);
	if (!keys.size) return undefined;
	const blind = components.filter((c) => c.reads === null);
	const whole_readers = components.filter((c) => c.whole);
	if (blind.length) notes.push(`${blind.length} component${blind.length > 1 ? 's' : ''} read the data in a way the scan could not name (${blind.map((c) => c.name).slice(0, 3).join(', ')}${blind.length > 3 ? '…' : ''}): their keys are unknown, so no key is called unread.`);
	if (whole_readers.length) notes.push(`${whole_readers.map((c) => c.name).slice(0, 3).join(', ')} take${whole_readers.length > 1 ? '' : 's'} the whole data object: every key may be read there.`);
	if (!any_lane) notes.push('No load returned keys the profiler could read from its source: the keys come from the seed and the readers alone.');
	const rows: LineageKey[] = [];
	for (const key of keys) {
		// the readers that NAME the key; a whole-object reader may read it, and says so in the row
		const named = components.filter((c) => c.reads?.includes(key));
		const readers = [...named, ...whole_readers.filter((w) => !named.includes(w))].map((c) => ({ name: c.name, island: c.island }));
		const shipped = input.seed[key] ?? 0;
		let verdict: KeyVerdict;
		if (named.some((c) => c.island)) verdict = 'island';
		// an island that takes the page whole may read it: shipped for a reason the scan cannot see
		else if (whole_readers.some((w) => w.island)) verdict = 'unknown';
		else if (named.length) verdict = shipped > 0 ? 'server-only' : 'server';
		else if (blind.length || whole_readers.length) verdict = 'unknown';
		else verdict = 'unread';
		rows.push({ key, from: from.get(key) ?? null, shipped_bytes: shipped, readers, verdict, load_wait_ms: wait.get(key) ?? null });
	}
	rows.sort((a, b) => b.shipped_bytes - a.shipped_bytes || (b.load_wait_ms ?? 0) - (a.load_wait_ms ?? 0));
	const unread = rows.filter((r) => r.verdict === 'unread').sort((a, b) => (b.load_wait_ms ?? 0) - (a.load_wait_ms ?? 0));
	const server_only = rows.filter((r) => r.verdict === 'server-only').sort((a, b) => b.shipped_bytes - a.shipped_bytes);
	return { keys: rows, components, unread, server_only, notes };
}
