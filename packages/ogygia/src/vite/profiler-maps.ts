/**
 * THE PROFILER'S MAPS, WRITTEN INTO THE CODE: after the server build has written its chunks (and
 * their hidden `.map` files), the module that `virtual:ogygia/profiler-maps` became gets one JSON
 * string in place of its placeholder: the module map (which source module sits at which lines of each
 * chunk) and every chunk's sourcemap, by chunk file.
 *
 * Why in the code: an adapter copies what the server code imports, not files read by path. Vercel's
 * traces imports (the `.map` files and `ogygia-modules.json` are left behind); adapter-node re-bundles
 * the chunks with maps of its own that point back at chunks it does not ship. A dynamic import rides
 * every adapter; the profiler loads it only when it resolves a frame, so a request pays nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PROFILER_MAPS_PLACEHOLDER } from '../compiler/ids.js';
import { GZ_PREFIX } from '../profiler/embedded-maps.js';
import { build_module_map } from './module-map.js';
import { client_maps_stash } from './server-sourcemaps.js';

/** the payload the profiler reads (profiler/embedded-maps.ts) */
export interface ProfilerMaps {
	v: 1;
	/** chunk file (relative to the server output) → [first line, last line, module id] */
	modules: Record<string, [number, number, string][]>;
	/** chunk file → its sourcemap, as the JSON text the build wrote */
	maps: Record<string, string>;
	/** a build WITHOUT maps: the app's own source files at the lines of its chunks, by module id
	 *  (`src/lib/x.ts`) — what the profiler matches the chunks' lines to by text on a host without
	 *  `src/` */
	sources?: Record<string, string>;
	/** ...and those chunks' own text, by chunk file */
	chunks?: Record<string, string>;
}

export function fill_profiler_maps(
	dir: string,
	bundle: Record<string, unknown>,
	root: string
): boolean {
	const chunks = Object.values(bundle).filter(
		(x): x is { type: string; fileName: string } =>
			(x as { type?: string }).type === 'chunk' &&
			typeof (x as { fileName?: unknown }).fileName === 'string'
	);
	// the chunk the maps module landed in: the one whose code carries the placeholder literal
	const quoted = [`"${PROFILER_MAPS_PLACEHOLDER}"`, `'${PROFILER_MAPS_PLACEHOLDER}'`];
	let target: { file: string; code: string } | undefined;
	for (const c of chunks) {
		const file = path.join(dir, c.fileName);
		let code: string;
		try {
			code = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		if (quoted.some((q) => code.includes(q))) {
			target = { file, code };
			break;
		}
	}
	if (!target) return false;
	const maps: Record<string, string> = {};
	const src = path.join(root, 'src') + path.sep;
	/** chunks the build wrote no map for */
	const mapless = new Set<string>();
	for (const c of chunks) {
		const file = path.join(dir, c.fileName);
		if (file === target.file) continue;
		let raw: string;
		try {
			raw = fs.readFileSync(file + '.map', 'utf8');
		} catch {
			// a build without maps: the module map names each chunk line's module, and the app's
			// own sources below are what its lines are matched to
			mapless.add(c.fileName);
			continue;
		}
		const slim = slim_map(raw, path.dirname(file), src);
		if (slim !== undefined) maps[c.fileName] = slim;
	}
	// THE BROWSER'S CHUNKS: the client build moved its hidden maps off the served output into the
	// stash (vite/server-sourcemaps.ts). The ones for chunks that carry the app's own code are kept,
	// under `client/<app dir>/immutable/…` (how the profiler keys a browser frame, whether it names a
	// local file or the URL: embedded-maps.ts); a runtime's or a package's chunk is left out (its
	// names are what the build already tells). The stash is removed either way.
	const client_dir = path.join(dir, '..', 'client');
	const stash = client_maps_stash(client_dir);
	for (const rel of list_maps(stash)) {
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(stash, rel), 'utf8');
		} catch {
			continue;
		}
		const chunk = rel.slice(0, -'.map'.length);
		const at = path.join(client_dir, chunk);
		if (!maps_app_code(raw, path.dirname(at), src)) continue;
		const slim = slim_map(raw, path.dirname(at), src);
		if (slim !== undefined) maps['client/' + chunk.split(path.sep).join('/')] = slim;
	}
	fs.rmSync(stash, { recursive: true, force: true });
	// the module map from the chunks AS WRITTEN: a plugin can rewrite a chunk after the bundle was
	// generated (Kit tree-shakes remote-function chunks in its writeBundle), and its lines are the
	// ones the profile will name
	const on_disk: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(bundle)) {
		const c = v as { type?: string; fileName?: string; code?: string };
		if (c.type !== 'chunk' || !c.fileName) {
			on_disk[k] = v;
			continue;
		}
		let code = c.code;
		try {
			code = fs.readFileSync(path.join(dir, c.fileName), 'utf8');
		} catch {
			/* keep the generated code */
		}
		on_disk[k] = { ...c, code };
	}
	const modules = build_module_map(on_disk, root).chunks;
	const sources: Record<string, string> = {};
	const texts: Record<string, string> = {};
	for (const chunk of mapless) {
		let app = false;
		for (const [, , id] of modules[chunk] ?? []) {
			if (!id.startsWith('src/') || is_data(id)) continue;
			app = true;
			if (id in sources) continue;
			try {
				sources[id] = fs.readFileSync(path.join(root, id), 'utf8');
			} catch {
				/* a module the build made up: nothing to read */
			}
		}
		// and the chunk itself, for a host that re-bundles the output (adapter-node): its own map
		// points back at this chunk, which it does not ship
		const code = (on_disk[chunk] as { code?: string } | undefined)?.code;
		if (app && typeof code === 'string') texts[chunk] = code;
	}
	const payload: ProfilerMaps = {
		v: 1,
		modules,
		maps,
		...(Object.keys(sources).length ? { sources } : {}),
		...(Object.keys(texts).length ? { chunks: texts } : {})
	};
	// one JS string literal: the JSON, gzipped and base64'd (a real app's maps are tens of MB of
	// text — every byte of it in the server bundle, and again in the map an adapter writes for this
	// chunk); inflated and parsed only when the profiler asks
	const literal = JSON.stringify(
		GZ_PREFIX + zlib.gzipSync(JSON.stringify(payload), { level: 9 }).toString('base64')
	);
	let code = target.code;
	for (const q of quoted) code = code.split(q).join(literal);
	fs.writeFileSync(target.file, code);
	return true;
}

const is_data = (source: string) => source.endsWith('.json');

/** every `.map` under `dir`, relative to it (none when it does not exist) */
function list_maps(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.map')) out.push(path.relative(dir, p));
		}
	};
	walk(dir);
	return out;
}

/** does this map's code come (in part) from the app's own files (a source under `src`) */
function maps_app_code(raw: string, chunk_dir: string, src: string): boolean {
	try {
		const map = JSON.parse(raw) as { sources?: unknown; sourceRoot?: unknown };
		const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
		return Array.isArray(map.sources) && map.sources.some((s) => typeof s === 'string' && path.resolve(chunk_dir, root + s).startsWith(src));
	} catch {
		return false;
	}
}

/**
 * A CHUNK'S MAP, CUT TO WHAT THE PROFILER READS: the mappings and names whole (every frame's line
 * and name), the source TEXT only for the app's own code files — what the source checks read on a
 * host without `src/` (a load line by line, a component's `{#each}`, a late island's data). A
 * package's text and imported data (`.json`: no function runs on its lines) are the bulk of a real
 * app's maps and never read there. Undefined for a map of data alone (nothing to name).
 */
export function slim_map(raw: string, chunk_dir: string, src: string): string | undefined {
	let map: { sources?: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string };
	try {
		map = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const sources = map.sources ?? [];
	if (sources.length > 0 && sources.every(is_data)) return undefined;
	if (Array.isArray(map.sourcesContent)) {
		const root = map.sourceRoot ?? '';
		map.sourcesContent = sources.map((s, i) => {
			const text = map.sourcesContent?.[i];
			if (typeof text !== 'string' || is_data(s)) return null;
			const abs = path.resolve(chunk_dir, root + s);
			return abs.startsWith(src) && !abs.includes(`${path.sep}node_modules${path.sep}`)
				? text
				: null;
		});
	}
	return JSON.stringify(map);
}
