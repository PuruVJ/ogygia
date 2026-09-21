/**
 * THE DATA RIVER — where the page's data comes from and where it goes: upstream calls (ms) feed
 * load functions, load functions produce `page.data` keys (bytes in the seed), keys are read by
 * islands. A wide band is a lot; a band that ends at a key nothing reads is data fetched and
 * shipped for no one. Pure: the host gathers the inputs (the timeline's calls per load lane, the
 * keys each load returns from its source, the keys each island reads from the build, the seed's
 * bytes per key from the rendered document) and this builds the four-column flow.
 */

export interface RiverNode {
	id: string;
	/** 0 calls · 1 loads · 2 keys · 3 islands */
	col: 0 | 1 | 2 | 3;
	label: string;
	/** the column's unit: ms for calls and loads, bytes for keys and islands */
	value: number;
	kind: 'call' | 'load' | 'key' | 'island' | 'unknown';
	detail?: string;
}

export interface RiverLink {
	from: string;
	to: string;
	value: number;
	unit: 'ms' | 'bytes';
}

export interface River {
	nodes: RiverNode[];
	links: RiverLink[];
	/** keys in the seed no island reads (only when at least one island names its keys) */
	waste: { key: string; bytes: number }[];
	notes: string[];
}

export interface RiverInput {
	/** the timeline's outbound calls, each on the load lane (file) that made it */
	calls: { lane: string | null; label: string; ms: number }[];
	/** each load lane and the keys its source returns (null: could not tell) */
	lanes: { file: string; keys: string[] | null; ms?: number }[];
	/** each island and the page.data keys it reads (null: reads everything) */
	islands: { name: string; keys: string[] | null }[];
	/** the seed's bytes per top-level page.data key */
	seed: Record<string, number>;
}

const short_call = (label: string) => {
	const m = /^([A-Z]+) (?:https?:\/\/)?([^/?#]+)?(\/[^?#\s]*)?/.exec(label);
	if (!m) return label.slice(0, 60);
	const path = m[3] ?? '/';
	return `${m[1]} ${path.length > 40 ? '…' + path.slice(-38) : path}`;
};

export function build_river(input: RiverInput): River {
	const nodes: RiverNode[] = [];
	const links: RiverLink[] = [];
	const notes: string[] = [];
	const node = (n: RiverNode) => {
		nodes.push(n);
		return n.id;
	};
	// loads
	const lane_ids = new Map<string, string>();
	for (const l of input.lanes) lane_ids.set(l.file, node({ id: `load:${l.file}`, col: 1, label: l.file, value: 0, kind: 'load', detail: l.keys ? `returns ${l.keys.join(', ')}` : 'returns keys the profiler could not read from its source' }));
	// calls → loads (grouped by lane + label so a loop of 8 identical calls is one band)
	const grouped = new Map<string, { lane: string | null; label: string; ms: number; n: number }>();
	for (const c of input.calls) {
		const k = `${c.lane ?? ''}|${short_call(c.label)}`;
		const g = grouped.get(k);
		if (g) {
			g.ms += c.ms;
			g.n++;
		} else grouped.set(k, { lane: c.lane, label: short_call(c.label), ms: c.ms, n: 1 });
	}
	let other_lane: string | null = null;
	for (const [k, g] of grouped) {
		const id = node({ id: `call:${k}`, col: 0, label: g.n > 1 ? `${g.label} ×${g.n}` : g.label, value: g.ms, kind: 'call', detail: `${Math.round(g.ms)} ms waiting${g.n > 1 ? ` over ${g.n} calls` : ''}` });
		let to = g.lane ? lane_ids.get(g.lane) : undefined;
		if (!to) {
			other_lane ??= node({ id: 'load:?', col: 1, label: 'outside a load', value: 0, kind: 'unknown', detail: 'a call made outside any load function (a hook, a component)' });
			to = other_lane;
		}
		links.push({ from: id, to, value: g.ms, unit: 'ms' });
		nodes.find((n) => n.id === to)!.value += g.ms;
	}
	// loads → keys
	const key_ids = new Map<string, string>();
	const key_node = (key: string) => {
		let id = key_ids.get(key);
		if (!id) key_ids.set(key, (id = node({ id: `key:${key}`, col: 2, label: key, value: input.seed[key] ?? 0, kind: 'key', detail: input.seed[key] !== undefined ? `${Math.round(input.seed[key] / 1024 * 10) / 10} KB in the seed` : 'not in the seed (no island reads it, or it never shipped)' })));
		return id;
	};
	const claimed = new Set<string>();
	for (const l of input.lanes) {
		const from = lane_ids.get(l.file)!;
		if (l.keys) {
			for (const k of l.keys) {
				claimed.add(k);
				links.push({ from, to: key_node(k), value: Math.max(input.seed[k] ?? 0, 1), unit: 'bytes' });
			}
		}
	}
	// keys the seed carries that no load claimed (a load whose source could not be read, a layout above)
	const unclaimed = Object.keys(input.seed).filter((k) => !claimed.has(k));
	if (unclaimed.length) {
		const from = input.lanes.find((l) => l.keys === null) ? lane_ids.get(input.lanes.find((l) => l.keys === null)!.file)! : node({ id: 'load:above', col: 1, label: 'a load outside the window', value: 0, kind: 'unknown', detail: 'a layout load that ran earlier, or one whose source the profiler could not read' });
		for (const k of unclaimed) links.push({ from, to: key_node(k), value: Math.max(input.seed[k] ?? 0, 1), unit: 'bytes' });
	}
	// keys → islands
	const named = input.islands.some((i) => i.keys && i.keys.length);
	const read = new Set<string>();
	for (const i of input.islands) {
		const id = node({ id: `island:${i.name}`, col: 3, label: i.name, value: 0, kind: 'island', detail: i.keys ? `reads ${i.keys.length ? i.keys.join(', ') : 'nothing from page.data'}` : 'reads page.data through a helper the build could not follow: the whole seed ships for it' });
		const keys = i.keys ?? Object.keys(input.seed);
		for (const k of keys) {
			if (input.seed[k] === undefined && !key_ids.has(k)) continue;
			read.add(k);
			const bytes = Math.max(input.seed[k] ?? 0, 1);
			links.push({ from: key_node(k), to: id, value: bytes, unit: 'bytes' });
			nodes.find((n) => n.id === id)!.value += bytes;
		}
	}
	const waste = named ? Object.entries(input.seed).filter(([k]) => !read.has(k)).map(([key, bytes]) => ({ key, bytes })).sort((a, b) => b.bytes - a.bytes) : [];
	if (waste.length) notes.push(`${waste.length} key${waste.length === 1 ? '' : 's'} in the seed that no island reads: ${waste.slice(0, 4).map((w) => `${w.key} (${Math.round(w.bytes / 1024 * 10) / 10} KB)`).join(', ')}.`);
	if (!named && input.islands.length) notes.push('No island names the keys it reads, so every key ships to every island. Read page.data keys directly in the island (or pass them as props) and the seed shrinks to what is used.');
	return { nodes, links, waste, notes };
}

// ── what a load returns (static) ─────────────────────────────────────────────────────────────

const LOAD_HEAD_RE = /export\s+(?:async\s+)?(?:function\s+load\s*\(|const\s+load\s*(?::[^=]+)?=)/;
const KEY_RE = /^(?:(?:"([^"]*)")|(?:'([^']*)')|([A-Za-z_$][\w$]*))\s*(?::|,|$|\})/;

/** The top-level keys a `load` function's `return { … }` object literals name — the union over
 *  every return; null when a return spreads something or returns a non-literal (the keys are then
 *  whatever that value has, which the source alone cannot say). */
export function load_return_keys(source: string): string[] | null {
	const head = LOAD_HEAD_RE.exec(source);
	if (!head) return null;
	const body = source.slice(head.index);
	const keys = new Set<string>();
	let found = false;
	let unknown = false;
	const RETURN_RE = /\breturn\s*(\{|\(|[^\s;{(])/g;
	let m: RegExpExecArray | null;
	while ((m = RETURN_RE.exec(body))) {
		found = true;
		let at = m.index + m[0].length - 1;
		if (body[at] === '(') {
			// `return (\n {` — skip the paren and whitespace
			let j = at + 1;
			while (j < body.length && /\s/.test(body[j])) j++;
			if (body[j] !== '{') {
				unknown = true;
				continue;
			}
			at = j;
		}
		if (body[at] !== '{') {
			unknown = true;
			continue;
		}
		// walk the object literal at depth 1, collecting keys
		let depth = 0;
		let i = at;
		let expect_key = true;
		while (i < body.length) {
			const ch = body[i];
			// a key where one is expected (quoted keys included) — before the string skip below
			if (depth === 1 && expect_key && !/\s/.test(ch) && !(ch === '/' && (body[i + 1] === '/' || body[i + 1] === '*'))) {
				if (body.startsWith('...', i)) {
					unknown = true;
					expect_key = false;
					i += 3;
					continue;
				}
				const km = KEY_RE.exec(body.slice(i, i + 200));
				if (km) {
					keys.add(km[1] ?? km[2] ?? km[3]);
					expect_key = false;
					i += km[0].length - (km[0].endsWith('}') || km[0].endsWith(',') ? 1 : 0);
					continue;
				}
				expect_key = false;
			}
			if (ch === '"' || ch === "'" || ch === '`') {
				// skip a string
				const q = ch;
				i++;
				while (i < body.length && body[i] !== q) i += body[i] === '\\' ? 2 : 1;
				i++;
				continue;
			}
			if (ch === '/' && body[i + 1] === '/') {
				while (i < body.length && body[i] !== '\n') i++;
				continue;
			}
			if (ch === '/' && body[i + 1] === '*') {
				i = body.indexOf('*/', i + 2);
				if (i === -1) i = body.length;
				i += 2;
				continue;
			}
			if (ch === '{' || ch === '(' || ch === '[') {
				depth++;
				if (depth === 1) expect_key = true;
				i++;
				continue;
			}
			if (ch === '}' || ch === ')' || ch === ']') {
				depth--;
				if (depth === 0) break;
				i++;
				continue;
			}
			if (depth === 1 && ch === ',') expect_key = true;
			i++;
		}
	}
	if (!found || unknown) return null;
	return [...keys];
}

/** The seed's bytes per top-level `page.data` key, from the seed script's text — plain JSON
 *  (`{ data: {…} }` or the keys themselves), or devalue's flat node array (`[{root…}, node, …]`,
 *  where an object's values and an array's items are node indices): a key's bytes are then the
 *  nodes reachable from it, so a node two keys share counts for both. */
export function seed_key_bytes(seed_json: string): Record<string, number> {
	try {
		const data = JSON.parse(seed_json) as unknown;
		if (Array.isArray(data) && data.length && data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) return devalue_key_bytes(data);
		const obj = (data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null) ?? null;
		if (!obj) return {};
		// the seed may wrap page.data: { data: {...} } or { page: { data } } — unwrap the common shapes
		const inner = (obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : null) ?? ((obj.page as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined) ?? obj;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(inner)) out[k] = JSON.stringify(v)?.length ?? 0;
		return out;
	} catch {
		return {};
	}
}

/** devalue's typed arrays: `["Date", "…"]`, `["Map", i, j…]`, `["Set", i…]`, `["Object", i]`,
 *  `["RegExp", …]`, `["BigInt", …]`, `["null"]` — the first element names the type, the rest are
 *  indices for the container kinds and plain values for the others */
const DEVALUE_CONTAINERS = new Set(['Map', 'Set', 'Object', 'Array']);

function devalue_key_bytes(nodes: unknown[]): Record<string, number> {
	const root = nodes[0] as Record<string, unknown>;
	const data_ix = typeof root.data === 'number' ? root.data : undefined;
	const data = data_ix !== undefined && data_ix >= 0 ? (nodes[data_ix] as Record<string, unknown>) : root;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
	const size = nodes.map((n) => JSON.stringify(n)?.length ?? 0);
	const refs = (n: unknown): number[] => {
		if (Array.isArray(n)) {
			if (typeof n[0] === 'string' && !DEVALUE_CONTAINERS.has(n[0])) return [];
			const items = typeof n[0] === 'string' ? n.slice(1) : n;
			return items.filter((x): x is number => typeof x === 'number' && x >= 0 && Number.isInteger(x));
		}
		if (n && typeof n === 'object') return Object.values(n as Record<string, unknown>).filter((x): x is number => typeof x === 'number' && x >= 0 && Number.isInteger(x));
		return [];
	};
	const out: Record<string, number> = {};
	for (const [key, ix] of Object.entries(data)) {
		if (typeof ix !== 'number' || ix < 0 || !Number.isInteger(ix)) {
			out[key] = 0;
			continue;
		}
		const seen = new Set<number>();
		const stack = [ix];
		let bytes = 0;
		while (stack.length) {
			const i = stack.pop()!;
			if (seen.has(i) || i >= nodes.length) continue;
			seen.add(i);
			bytes += size[i];
			for (const r of refs(nodes[i])) if (!seen.has(r)) stack.push(r);
		}
		out[key] = bytes;
	}
	return out;
}
