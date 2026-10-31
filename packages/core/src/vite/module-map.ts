/**
 * THE MODULE MAP: for each server chunk, which source module's code sits at which lines — written
 * once per server build, beside the chunks (`ogygia-modules.json`), so it travels with them to
 * whatever host runs the build. A build without sourcemaps (the normal one) leaves the profiler
 * only chunk names; with this it still tells its own code, ogygia's runtime and a bundled package's
 * from the app's (profiler/module-map.ts reads it).
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODULE_MAP_FILE = 'ogygia-modules.json';

/** chunk file (relative to the output dir) → [first line, last line, module id relative to root] */
export type ModuleMap = { v: 1; chunks: Record<string, [number, number, string][]> };

type ChunkLike = {
	type?: string;
	fileName?: string;
	code?: string;
	modules?: Record<string, { code?: string | null }>;
};

function count_lines(s: string, from: number, to: number): number {
	let n = 0;
	for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

/** where a module's code starts in the chunk, found by its first line of real code (24+ characters,
 *  not an import / export-from / comment) and counted back to the module's first line: the chunk
 *  offset of that start, or -1. Lines before the anchor that the bundler dropped (the imports) make
 *  the start land a little early, never inside the previous module's own code by more than those */
function by_solid_line(
	chunk: string,
	code: string,
	cursor: number
): { at: number; dropped: number } | undefined {
	const lines = code.split('\n');
	const dropped_line = (t: string) =>
		t.startsWith('import ') || (t.startsWith('export ') && t.includes(' from '));
	for (let i = 0; i < lines.length && i < 80; i++) {
		const l = lines[i].trim();
		if (
			l.length < 24 ||
			dropped_line(l) ||
			l.startsWith('//') ||
			l.startsWith('/*') ||
			l.startsWith('*')
		)
			continue;
		let at = chunk.indexOf(l, cursor);
		if (at === -1) at = chunk.indexOf(l);
		if (at === -1) continue;
		// the line's start in the chunk, then back over the module lines kept above it (the dropped
		// imports are not in the chunk, so only the others count)
		let start = chunk.lastIndexOf('\n', at - 1) + 1;
		let kept = 0;
		let dropped = 0;
		for (let j = 0; j < i; j++) {
			if (dropped_line(lines[j].trim())) dropped++;
			else kept++;
		}
		for (let k = 0; k < kept && start > 0; k++) start = chunk.lastIndexOf('\n', start - 2) + 1;
		// (the imports after the anchor are dropped too: the module's lines in the chunk are fewer)
		for (let j = i + 1; j < lines.length; j++) if (dropped_line(lines[j].trim())) dropped++;
		return { at: start, dropped };
	}
	return undefined;
}

/** a module id as the map keeps it: relative to the root, a package from its `node_modules/` */
function clean_id(id: string, root: string): string {
	const q = id.indexOf('?');
	const clean = (q === -1 ? id : id.slice(0, q)).replace(/^\0/, '');
	const rel = path.isAbsolute(clean) ? path.relative(root, clean).split(path.sep).join('/') : clean;
	const nm = rel.lastIndexOf('node_modules/');
	return nm === -1 ? rel : rel.slice(nm);
}

/** THE BUNDLER'S OWN MARKERS: rolldown writes `//#region <module>` … `//#endregion` around each
 *  module's code — exact lines, no guessing. Undefined when the chunk has none (another bundler) */
function by_regions(code: string, root: string): [number, number, string][] | undefined {
	if (!code.includes('\n//#region ') && !code.startsWith('//#region ')) return undefined;
	const out: [number, number, string][] = [];
	let line = 1;
	// a STACK: the app's own folding comments (`//#region Helpers`) survive bundling inside a module,
	// and only a marker naming a module (a path, or a virtual id) is the bundler's
	const open: { start: number; id: string; module: boolean }[] = [];
	const names_module = (id: string) =>
		id.includes('/') || id.includes('\\') || id.includes(':') || /\.[a-z]+$/i.test(id);
	for (let i = 0; i <= code.length;) {
		const nl = code.indexOf('\n', i);
		const end = nl === -1 ? code.length : nl;
		if (code.startsWith('//#region ', i)) {
			const id = code.slice(i + 10, end).trim();
			open.push({ start: line + 1, id, module: names_module(id) });
		} else if (code.startsWith('//#endregion', i) && open.length) {
			const top = open.pop()!;
			if (top.module) {
				// (the marker path is relative to the root, or climbs out of it into a package)
				let id = top.id;
				while (id.startsWith('../')) id = id.slice(3);
				if (line - 1 >= top.start) out.push([top.start, line - 1, clean_id(id, root)]);
			}
		}
		if (nl === -1) break;
		i = nl + 1;
		line++;
	}
	return out.length ? out : undefined;
}

export function build_module_map(bundle: Record<string, unknown>, root: string): ModuleMap {
	const chunks: ModuleMap['chunks'] = {};
	for (const item of Object.values(bundle)) {
		const c = item as ChunkLike;
		if (c.type !== 'chunk' || !c.fileName || !c.code || !c.modules) continue;
		const marked = by_regions(c.code, root);
		if (marked) {
			chunks[c.fileName] = marked;
			continue;
		}
		const out: [number, number, string][] = [];
		let cursor = 0;
		let line = 1;
		for (const [id, m] of Object.entries(c.modules)) {
			if (!m.code) continue;
			// modules are rendered in order: find each after the last (a copy earlier in the chunk would
			// be another module's text). By its OPENING text: hooks that run after rendering (a
			// renderChunk patch) may change the chunk, so the whole module rarely matches byte for byte;
			// its length in lines comes from the module's own code
			const head = m.code.slice(0, Math.min(m.code.length, 120));
			let at = c.code.indexOf(head, cursor);
			if (at === -1) at = c.code.indexOf(head);
			// not by its opening (a bundler drops or rewrites a module's `import` lines, and those open
			// most modules): by its first SOLID line — code, not an import — found in the chunk, and the
			// module's start counted back from there
			let dropped = 0;
			if (at === -1) {
				const found = by_solid_line(c.code, m.code, cursor);
				if (!found) continue;
				at = found.at;
				dropped = found.dropped;
			}
			const start =
				at >= cursor ? line + count_lines(c.code, cursor, at) : 1 + count_lines(c.code, 0, at);
			// its lines in the chunk: its own, less the imports the bundler dropped
			const span = Math.max(1, count_lines(m.code, 0, m.code.length) - dropped);
			// its last line (a module ending in a newline stops on the line before the next begins)
			const end = start + span - (m.code.endsWith('\n') ? 1 : 0);
			const q = id.indexOf('?');
			const clean = (q === -1 ? id : id.slice(0, q)).replace(/^\0/, '');
			const rel = path.isAbsolute(clean)
				? path.relative(root, clean).split(path.sep).join('/')
				: clean;
			// a package by its own path (pnpm's store folders are long and say nothing more)
			const nm = rel.lastIndexOf('node_modules/');
			out.push([start, end, nm === -1 ? rel : rel.slice(nm)]);
			if (at >= cursor) {
				// the line the cursor lands on: just past the module's last newline
				line = start + span;
				// past this module: its line count on from where it starts
				// from the module's first character on (a module starting with a newline counts it)
				let p = at - 1;
				for (let k = 0; k < span && p !== -1; k++) p = c.code.indexOf('\n', p + 1);
				// just past its last newline: the next line is the first after it
				cursor = p === -1 ? c.code.length : p + 1;
			}
		}
		// a module's own code can carry a line more than it takes in the chunk (a trailing newline the
		// chunk drops): it ends where the next begins
		out.sort((x, y) => x[0] - y[0]);
		for (let i = 0; i + 1 < out.length; i++)
			if (out[i][1] >= out[i + 1][0]) out[i][1] = out[i + 1][0] - 1;
		if (out.length) chunks[c.fileName] = out;
	}
	return { v: 1, chunks };
}

export function write_module_map(dir: string, bundle: Record<string, unknown>, root: string): void {
	const map = build_module_map(bundle, root);
	if (Object.keys(map.chunks).length)
		fs.writeFileSync(path.join(dir, MODULE_MAP_FILE), JSON.stringify(map));
}
