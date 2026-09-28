/**
 * THE MAPS THE BUILD WROTE INTO THE CODE (vite/profiler-maps.ts), read back: the module map and
 * every server chunk's sourcemap, by chunk file relative to the server output. Loaded once, on the
 * first resolve, from `virtual:ogygia/profiler-maps` — a dynamic import, so it ships with whatever
 * the adapter ships and costs a request nothing. Null outside a profiler-on server build.
 */

export interface EmbeddedMaps {
	modules: Record<string, [number, number, string][]>;
	maps: Record<string, string>;
	/** a build without maps: the app's source files by module id (`src/lib/x.ts`) */
	sources?: Record<string, string>;
	/** ...and the text of the chunks they are in, by chunk file */
	chunks?: Record<string, string>;
}

let loaded: Promise<EmbeddedMaps | null> | undefined;
let ready: EmbeddedMaps | null = null;

/** the payload's mark: gzipped JSON, base64 (vite/profiler-maps.ts) */
export const GZ_PREFIX = 'gz:';

export function load_embedded_maps(): Promise<EmbeddedMaps | null> {
	loaded ??= import('virtual:ogygia/profiler-maps')
		.then(async (m) => {
			let raw = (m as { default?: unknown }).default;
			if (typeof raw === 'string' && raw.startsWith(GZ_PREFIX)) {
				const zlib = await import('node:zlib');
				raw = zlib
					.gunzipSync(Buffer.from(raw.slice(GZ_PREFIX.length), 'base64'))
					.toString('utf8');
			}
			// the placeholder (a build that did not fill it) and null alike: nothing
			if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
			const p = JSON.parse(raw) as { v?: number } & EmbeddedMaps;
			return p.v === 1 && p.maps && p.modules
				? (ready = {
						modules: p.modules,
						maps: p.maps,
						...(p.sources && typeof p.sources === 'object' ? { sources: p.sources } : {}),
						...(p.chunks && typeof p.chunks === 'object' ? { chunks: p.chunks } : {})
					})
				: null;
		})
		.catch(() => null);
	return loaded;
}

/** the maps once loaded (synchronous readers: the module map lookup), else null */
export const embedded_maps = (): EmbeddedMaps | null => ready;

/** a script's key in the payload: its path under the server output (`chunks/format.js`), whether it
 *  runs from Kit's output itself (a host that copies it, like Vercel's) or is named as a map source
 *  by an adapter that re-bundled it (adapter-node: `…/.svelte-kit/output/server/chunks/x.js`) */
export function embedded_key(path: string): string | undefined {
	const p = path.split('\\').join('/');
	const at = p.lastIndexOf('/output/server/');
	if (at === -1) return undefined;
	// the app root this chunk path sits under: an absolute source path is the app's only below it
	const kit = p.lastIndexOf('/.svelte-kit/', at);
	if (kit !== -1 && kit + '/.svelte-kit'.length === at) roots.add(p.slice(0, kit));
	return p.slice(at + '/output/server/'.length);
}

/** app roots seen in chunk paths (`<root>/.svelte-kit/output/server/…`) */
const roots = new Set<string>();

/** where the maps' relative sources are resolved from: the chunk's folder under a stand-in root */
const VIRTUAL_ROOT = '/ROOT';
const VIRTUAL_SERVER = VIRTUAL_ROOT + '/.svelte-kit/output/server/';
const VIRTUAL_SRC = VIRTUAL_ROOT + '/src/';

/** `a/b/../c/./d` → `a/c/d` (posix, absolute input) */
function normalize(p: string): string {
	const out: string[] = [];
	for (const part of p.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return '/' + out.join('/');
}

/** the build's map of a chunk, by its path: the text the build wrote, or undefined */
export function embedded_map_of(path: string): string | undefined {
	const key = embedded_key(path);
	return key !== undefined ? ready?.maps[key] : undefined;
}

/** a built chunk's text the build carried (a build without maps, for a host that re-bundled it) */
export function embedded_chunk(path: string): string | undefined {
	const key = embedded_key(path);
	return key !== undefined ? ready?.chunks?.[key] : undefined;
}

/** src-relative path (`routes/x/+page.server.ts`) → the source text the maps carry, built once */
let sources: Map<string, string> | undefined;

/**
 * AN APP SOURCE FILE'S TEXT FROM THE MAPS (`sourcesContent`): the only copy on a deployed host, where
 * `src/` is not there. What the source-reading checks (a load read line by line, a component's
 * `{#each}`, a late island's data) read when the file is not on disk. `file` is src-relative or has
 * a leading `src/`; undefined when no map carries it.
 */
export function embedded_source(file: string): string | undefined {
	const index = source_index();
	if (!index) return undefined;
	const f = file.split('\\').join('/');
	if (f.includes('/node_modules/')) return undefined;
	let rel: string | undefined;
	if (f.startsWith('src/')) rel = f.slice(4);
	else if (f.startsWith('/')) {
		// only under an app root: another package's `src/` is not the app's
		for (const r of [...roots, cwd()]) {
			if (r && f.startsWith(r + '/src/')) {
				rel = f.slice(r.length + 5);
				break;
			}
		}
	} else rel = f;
	return rel === undefined ? undefined : index.get(rel);
}

function cwd(): string | undefined {
	try {
		return process.cwd().split('\\').join('/');
	} catch {
		return undefined;
	}
}

/** every app source file the maps carry, src-relative */
export function embedded_files(): string[] {
	return [...(source_index()?.keys() ?? [])];
}

function source_index(): Map<string, string> | undefined {
	if (!ready) return undefined;
	if (!sources) {
		sources = new Map();
		for (const [key, raw] of Object.entries(ready.maps)) {
			let map: { sources?: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string };
			try {
				map = JSON.parse(raw);
			} catch {
				continue;
			}
			const dir = VIRTUAL_SERVER + key.slice(0, key.lastIndexOf('/') + 1);
			const list = map.sources ?? [];
			for (let i = 0; i < list.length; i++) {
				const text = map.sourcesContent?.[i];
				if (typeof text !== 'string') continue;
				const s = ((map.sourceRoot ?? '') + list[i]).split('\\').join('/');
				// relative sources resolve from the chunk's folder; the app's own files are the ones
				// that land under the app's src/ (a workspace package's `src/` lands elsewhere)
				if (s.startsWith('/') || s.includes(':')) continue;
				const p = normalize(dir + s);
				if (!p.startsWith(VIRTUAL_SRC)) continue;
				const rel = p.slice(VIRTUAL_SRC.length);
				if (!sources.has(rel)) sources.set(rel, text);
			}
		}
		// a build without maps: the app's own files the build carried as they are
		for (const [id, text] of Object.entries(ready.sources ?? {}))
			if (id.startsWith('src/') && typeof text === 'string' && !sources.has(id.slice(4)))
				sources.set(id.slice(4), text);
	}
	return sources;
}

/** the module at a chunk line, from the embedded module map (a host that dropped the file beside the
 *  chunks) */
export function embedded_module_at(path: string, line: number): string | undefined {
	const key = embedded_key(path);
	const ranges = key !== undefined ? ready?.modules[key] : undefined;
	if (!ranges) return undefined;
	for (const [a, b, id] of ranges) if (line >= a && line <= b) return id;
	return undefined;
}
