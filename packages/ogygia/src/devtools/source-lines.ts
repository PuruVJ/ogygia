/**
 * THE SOURCE'S LINE FOR A SAMPLED FRAME, IN THE PAGE. The browser's sampler names a frame by the line
 * of the code as served; on the dev server a `.svelte` file is served compiled, so that line is the
 * compiled output's (`save` read as SlowSave.svelte:18, written at line 5). The dev server puts each
 * module's source map inline at its end; this reads it once per file and answers the source line of a
 * served line (its first mapped segment). Asked synchronously: `undefined` while the file is being
 * read (the next look has it), `null` when it cannot say (no inline map: a build's chunk, a file the
 * dev server did not transform). No regex: the map's marker is found by search, the VLQ by table.
 */

const MARK = '//# sourceMappingURL=data:application/json;base64,';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map<string, number>([...B64].map((c, i) => [c, i]));

/** served line (1-based) → source line (1-based), or 0 where the line maps nowhere */
type Lines = Int32Array;
const ready = new Map<string, Lines | null>();
const pending = new Set<string>();

/**
 * Each generated line's first segment that names a source → that source line; only segments of the
 * map's first source (a `.svelte` module maps to itself; helpers it inlined are not its lines).
 */
export function lines_of_map(mappings: string, want_source = 0): Lines {
	const rows = mappings.split(';');
	const out = new Int32Array(rows.length + 1);
	let src = 0;
	let src_line = 0;
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		let i = 0;
		let found = 0;
		while (i < row.length) {
			// one segment: up to five VLQ fields, `,` between segments
			const fields: number[] = [];
			while (i < row.length && row[i] !== ',') {
				let value = 0;
				let shift = 0;
				let more = true;
				while (more && i < row.length) {
					const digit = B64_INDEX.get(row[i++]) ?? 0;
					more = (digit & 32) !== 0;
					value += (digit & 31) << shift;
					shift += 5;
				}
				fields.push(value & 1 ? -(value >> 1) : value >> 1);
			}
			i++;
			if (fields.length >= 4) {
				src += fields[1];
				src_line += fields[2];
				if (!found && src === want_source) found = src_line + 1;
			}
		}
		out[r + 1] = found;
	}
	return out;
}

/** the served file's source line map, read from its inline map (null when it has none) */
function parse(text: string, file: string): Lines | null {
	const at = text.lastIndexOf(MARK);
	if (at === -1) return null;
	let end = text.indexOf('\n', at);
	if (end === -1) end = text.length;
	try {
		const map = JSON.parse(atob(text.slice(at + MARK.length, end).trim())) as { mappings?: unknown; sources?: unknown };
		if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null;
		// the source that is this file (by its name), else the first
		const base = file.slice(file.lastIndexOf('/') + 1);
		const own = (map.sources as unknown[]).findIndex((s) => typeof s === 'string' && s.slice(s.lastIndexOf('/') + 1) === base);
		return lines_of_map(map.mappings, own === -1 ? 0 : own);
	} catch {
		return null;
	}
}

/**
 * The source line of `line` in the app file `file` (`src/…`, as the CPU view names it). `undefined`
 * while it is being read, `null` when it cannot be told.
 */
export function source_line(file: string, line: number | null): number | null | undefined {
	if (line === null || !file.startsWith('src/')) return null;
	const hit = ready.get(file);
	if (hit === null) return null;
	if (hit) return hit[line] || null;
	if (!pending.has(file) && typeof fetch === 'function') {
		pending.add(file);
		fetch('/' + file)
			.then((r) => (r.ok ? r.text() : ''))
			.then((t) => ready.set(file, t ? parse(t, file) : null))
			.catch(() => ready.set(file, null))
			.finally(() => pending.delete(file));
	}
	return undefined;
}

/**
 * Functions with the source's lines: each mapped where the file's map says, else its line dropped
 * (a served line is not the source's). `mapped`: every app function among them has its source line.
 */
export function with_source_lines<F extends { file: string; line: number | null }>(fns: readonly F[]): { fns: F[]; mapped: boolean } {
	let mapped = true;
	const out = fns.map((f) => {
		const l = source_line(f.file, f.line);
		if (l) return { ...f, line: l };
		if (f.file.startsWith('src/')) mapped = false;
		return { ...f, line: null };
	});
	return { fns: out, mapped };
}
