/**
 * `import.meta.og.regions(glob)` — the block registry as a compile construct. A CMS block registry is
 * N hand-written lines that never stay in sync with the folder:
 *
 *   import Hero    from './blocks/Hero.svelte'    with { region: 'raw' };
 *   import Prose   from './blocks/Prose.svelte'   with { region: 'raw' };
 *   export const registry = { Hero, Prose };
 *
 * The construct collapses that to one line that CANNOT drift:
 *
 *   export const registry = import.meta.og.regions('./blocks/*.svelte');
 *
 * At build the macro globs the pattern (relative to the module), emits one
 * `import <alias> from '<file>' with { region: 'raw' }` per match — so each block is a raw held
 * region, its own nested islands wake — and assembles a `{ <Basename>: <alias> }` object keyed by the
 * file's basename (the CMS `type` name). A block that needs a wake schedule stays a manual import,
 * spread over the top: `{ ...import.meta.og.regions('./blocks/*.svelte'), Counter }`.
 *
 * Detection is AST-precise (the shared `import.meta.og.*` scanner); a marker in a comment or string
 * is never a call. Node-only (filesystem glob). Server-only by nature — a block registry drives SSR.
 */
import { fs, path } from '../host.js';
import { find_og_calls, split_first_string } from '../parse/scan.js';

const PREFIX = 'import.meta.og.regions';

/** The registry key for a block file — its basename, VERBATIM (minus extension). No normalization:
 *  the key is a string key on the registry object and must match the CMS `type` string exactly, and
 *  the author controls both the filename and the type. `Hero.svelte` → `Hero`; `hero-banner.svelte`
 *  → `hero-banner`. Predictable beats clever — a guessed PascalCase would silently miss the type. */
export function region_key(file: string): string {
	return path.basename(file).replace(/\.[^.]+$/, '');
}

/**
 * Rewrite every `import.meta.og.regions(glob)` call in `src` to a `{ Key: alias }` object literal,
 * injecting the raw-region imports. `id` is the importing module's absolute path (the glob resolves
 * relative to its directory). Returns the input unchanged (same reference) when there is nothing to
 * do. Throws build-voice on a bad glob (non-literal, or a duplicate key across two files).
 */
export function rewrite_regions(src: string, id: string): string {
	if (!src.includes(PREFIX)) return src;
	const calls = find_og_calls(src, 'import.meta.og.');
	const region_calls = calls.filter((c) => c.method === 'regions');
	if (!region_calls.length) return src;

	const dir = path.dirname(id.split('?')[0]!);
	const imports: string[] = [];
	let alias_n = 0;
	let out = '';
	let last = 0;

	for (const c of region_calls) {
		const { value: glob } = split_first_string(c.args, 'import.meta.og.regions()');
		const files = glob_relative(dir, glob);
		const entries: string[] = [];
		const seen = new Map<string, string>();
		for (const abs of files) {
			const key = region_key(abs);
			if (seen.has(key)) {
				throw new Error(
					`[ogygia] import.meta.og.regions('${glob}'): two files map to the block key '${key}' ` +
						`(${path.relative(dir, seen.get(key)!)} and ${path.relative(dir, abs)}). Rename one.`
				);
			}
			seen.set(key, abs);
			const alias = `__og_region_${alias_n++}`;
			// Module-relative specifier with a leading `./` so Vite resolves it like an authored import.
			let spec = path.relative(dir, abs).split(path.sep).join('/');
			if (!spec.startsWith('.')) spec = './' + spec;
			imports.push(`import ${alias} from ${JSON.stringify(spec)} with { region: 'raw' };`);
			entries.push(`${JSON.stringify(key)}: ${alias}`);
		}
		out += src.slice(last, c.start) + `{ ${entries.join(', ')} }`;
		last = c.end;
	}
	out += src.slice(last);
	return imports.join('\n') + '\n' + out;
}

/** Resolve a LITERAL glob (relative to `dir`) to sorted absolute file paths. Supports the shapes a
 *  block folder uses (`*.svelte`, `**​/*.svelte`, `blocks/*.svelte`). */
function glob_relative(dir: string, glob: string): string[] {
	// `fs.globSync` (Node ≥ 22) with cwd = the module's directory; sort for deterministic output.
	const matches = fs.globSync(glob, { cwd: dir }) as string[];
	return matches
		.map((m) => path.resolve(dir, m))
		.filter((p) => {
			try {
				return fs.statSync(p).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}
