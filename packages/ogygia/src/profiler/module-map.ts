/**
 * THE MODULE MAP, read (the build writes it: vite/module-map.ts). A frame in a bundled server chunk
 * (`…/output/server/chunks/frames.js:12`) with no sourcemap names only the chunk; the map says which
 * source module is at that line, so the frame is filed by what it is — this profiler's own code
 * (overhead, not the app's time), ogygia's runtime or a bundled package (a library), else the app.
 * The map sits beside the chunks, found by walking up from the chunk's folder, wherever the host put
 * the build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrameCategory } from './analyze.js';
import { embedded_module_at } from './embedded-maps.js';

const MODULE_MAP_FILE = 'ogygia-modules.json';

type Loaded = { dir: string; chunks: Record<string, [number, number, string][]> } | null;

/** `(url, line) → module id` over the module maps found beside the chunks (memoized per folder) */
export function module_lookup(): (url: string, line: number) => string | undefined {
	const by_dir = new Map<string, Loaded>();
	const find = (start: string): Loaded => {
		const seen: string[] = [];
		let dir = start;
		let found: Loaded = null;
		for (let i = 0; i < 6; i++) {
			if (by_dir.has(dir)) {
				found = by_dir.get(dir)!;
				break;
			}
			seen.push(dir);
			const file = path.join(dir, MODULE_MAP_FILE);
			if (fs.existsSync(file)) {
				try {
					found = {
						dir,
						chunks: (
							JSON.parse(fs.readFileSync(file, 'utf8')) as { chunks: NonNullable<Loaded>['chunks'] }
						).chunks
					};
				} catch {
					found = null;
				}
				break;
			}
			const up = path.dirname(dir);
			if (up === dir) break;
			dir = up;
		}
		for (const d of seen) by_dir.set(d, found);
		return found;
	};
	return (url, line) => {
		let file = url;
		if (file.startsWith('file://')) {
			try {
				file = fileURLToPath(file);
			} catch {
				return undefined;
			}
		}
		// a relative script name (Lambda / Amplify hand V8 those): from the process's folder
		if (!path.isAbsolute(file)) file = path.resolve(process.cwd(), file);
		const m = find(path.dirname(file));
		// no map file beside the chunks (an adapter that copies only what the code imports): the copy
		// the build wrote into the code, once the profiler has loaded it
		if (!m) return embedded_module_at(file, line);
		const ranges = m.chunks[path.relative(m.dir, file).split(path.sep).join('/')];
		if (!ranges) return embedded_module_at(file, line);
		for (const [a, b, id] of ranges) if (line >= a && line <= b) return id;
		return undefined;
	};
}

/** a script that MAY be a built server chunk: JavaScript outside node_modules and Node's own — an
 *  absolute build path, or the RELATIVE name a Lambda / Amplify host hands V8 (`./chunks/x.js`). The
 *  module map beside it has the last word (no map, no entry: not a chunk) */
export const may_be_chunk = (file: string): boolean =>
	!!file &&
	!file.startsWith('node:') &&
	!file.includes('/node_modules/') &&
	!file.includes('\\node_modules\\') &&
	(file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs'));

/** a module id's kind: this profiler's code, ogygia's runtime, a package, or (undefined) the app's */
export function module_category(id: string): { category: FrameCategory; pkg?: string } | undefined {
	const posix = id.split('\\').join('/');
	// ogygia's generated modules (the island wrappers, the virtual runtime entries): its code, not the app's
	// (in any spelling: bare, with the NUL prefix Vite gives virtual ids, or that NUL written out)
	if (posix.includes('virtual:ogygia')) return { category: 'dependency', pkg: 'ogygia' };
	const nm = posix.lastIndexOf('node_modules/');
	const own = (p: string) => p.includes('ogygia/src/') || p.includes('ogygia/dist/');
	if (nm !== -1) {
		const rest = posix.slice(nm + 'node_modules/'.length).split('/');
		const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
		if (pkg === 'ogygia' && rest.includes('profiler')) return { category: 'profiler' };
		if (pkg === 'svelte') return { category: 'svelte', pkg };
		return { category: 'dependency', pkg };
	}
	if (own(posix))
		return posix.includes('/profiler/')
			? { category: 'profiler' }
			: { category: 'dependency', pkg: 'ogygia' };
	return undefined;
}
