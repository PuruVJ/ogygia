/**
 * THE BYTE LEDGER, EXACT — each island's JavaScript from the page's own island graph (the chunk list
 * a build writes for every island entry, `script[data-ogygia-graph]`) and the browser's byte counts
 * per file (resource timing). Pure: the graph, the sizes and the islands in; out:
 *
 * - per island: its files, what they weigh, the part ONLY it needs (`unique`: what removing the
 *   island would save) and the part it shares with other islands;
 * - the page: every file counted once (not once per island that imports it);
 * - the shared files, heaviest first, with the islands that use each.
 *
 * The runtime's own files are shared by every island and kept apart. A file the browser has not
 * loaded yet (an island still asleep) has no size: it is counted as cold, not as zero.
 */

export interface LedgerIsland {
	/** absolute entry URL (its identity: the graph's key) */
	entry: string;
	/** the file it loads, absolute (its content-hashed location); absent → the entry itself */
	file?: string;
	name: string;
	kind: string;
	wake: string;
	/** copies of it on the page */
	count: number;
}

export interface FileSize {
	/** bytes over the wire (compressed) */
	wire: number;
	/** decoded bytes */
	raw: number;
}

export interface LedgerRow {
	entry: string;
	name: string;
	kind: string;
	wake: string;
	count: number;
	/** files its code needs (the entry and its chunks; not the runtime's) */
	files: number;
	/** the loaded ones' wire bytes */
	wire: number;
	/** only this island needs these (what removing it would save) */
	unique: number;
	/** shared with at least one other island on the page */
	shared: number;
	/** files not loaded yet (it is asleep): no size known */
	cold: number;
}

export interface Ledger {
	rows: LedgerRow[];
	/** every file once: the islands' and the runtime's */
	page: { files: number; wire: number; raw: number; cold: number };
	runtime: { files: number; wire: number };
	/** shared files, heaviest first, with who uses them */
	shared: { url: string; wire: number; users: string[] }[];
}

export function byte_ledger(
	islands: readonly LedgerIsland[],
	graph: ReadonlyMap<string, readonly string[]>,
	size: (url: string) => FileSize | null,
	runtime: readonly string[]
): Ledger {
	const runtime_set = new Set(runtime);
	const files_of = new Map<string, string[]>();
	const users = new Map<string, Set<string>>();
	for (const i of islands) {
		if (files_of.has(i.entry)) continue;
		const list = [...new Set([i.file ?? i.entry, ...(graph.get(i.entry) ?? [])])].filter((u) => !runtime_set.has(u));
		files_of.set(i.entry, list);
		for (const u of list) (users.get(u) ?? users.set(u, new Set()).get(u)!).add(i.entry);
	}
	const name_of = new Map(islands.map((i) => [i.entry, i.name]));
	const rows: LedgerRow[] = [];
	const seen = new Set<string>();
	for (const i of islands) {
		if (seen.has(i.entry)) continue;
		seen.add(i.entry);
		const list = files_of.get(i.entry)!;
		let wire = 0;
		let unique = 0;
		let shared = 0;
		let cold = 0;
		for (const u of list) {
			const s = size(u);
			if (!s) {
				cold++;
				continue;
			}
			wire += s.wire;
			if ((users.get(u)?.size ?? 0) > 1) shared += s.wire;
			else unique += s.wire;
		}
		rows.push({ entry: i.entry, name: i.name, kind: i.kind, wake: i.wake, count: i.count, files: list.length, wire, unique, shared, cold });
	}
	rows.sort((a, b) => b.unique - a.unique || b.wire - a.wire);

	let page_wire = 0;
	let page_raw = 0;
	let page_cold = 0;
	const all = new Set([...users.keys(), ...runtime]);
	for (const u of all) {
		const s = size(u);
		if (!s) page_cold++;
		else {
			page_wire += s.wire;
			page_raw += s.raw;
		}
	}
	let runtime_wire = 0;
	for (const u of runtime) runtime_wire += size(u)?.wire ?? 0;
	const shared = [...users]
		.filter(([, who]) => who.size > 1)
		.map(([url, who]) => ({ url, wire: size(url)?.wire ?? 0, users: [...who].map((e) => name_of.get(e) ?? e) }))
		.filter((s) => s.wire > 0)
		.sort((a, b) => b.wire - a.wire);
	return {
		rows,
		page: { files: all.size, wire: page_wire, raw: page_raw, cold: page_cold },
		runtime: { files: runtime.length, wire: runtime_wire },
		shared
	};
}
