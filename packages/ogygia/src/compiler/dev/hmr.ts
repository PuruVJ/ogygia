/**
 * HMR reload-decision helpers — pure policy functions the Vite adapter's `handleHotUpdate` /
 * `watchChange` consult to decide between a soft update and a full document reload. No build state;
 * data in → decision out. Covered by unit tests.
 */
import { path } from '../host.js';

const BACKSLASH = /\\/g;
const STYLE_EXT = /\.(css|scss|sass|less|styl)(?:$|\?)/i;
const KIT_ROUTE_FILE = /(?:^|\/)\+(?:page|layout|error|server|hooks)(?:\.|$)/;

/**
 * Host route shells (`+page` / `+layout` / …) never join the browser module graph under
 * `csr=false`, so Vite's fine-grained HMR for them has no client importer. Force a full reload.
 * Standalone CSS is soft-updated via `virtual:ogygia/dev-hmr` (Vite inject after Kit FOUC).
 * If that soft path fails, the client bridge listens for `vite:error` and reloads the document.
 *
 * @internal HMR policy helper (also covered by unit tests).
 */
export function needs_csr_false_full_reload(file: string) {
	const norm = file.replace(BACKSLASH, '/');
	if (STYLE_EXT.test(norm)) return false;
	return KIT_ROUTE_FILE.test(norm);
}

/**
 * Island entry `.svelte` files (the `import X from '…' with { hydrate }`) sit behind a virtual
 * wrapper; Svelte soft HMR through that edge is unreliable. Shared `.ts` deps still soft-update.
 *
 * @internal HMR policy helper (also covered by unit tests).
 */
export function needs_island_entry_full_reload(
	file: string,
	entries: Iterable<{ componentPath?: string | null }>
) {
	const bare = file.split('?')[0];
	if (!bare.endsWith('.svelte')) return false;
	if (STYLE_EXT.test(bare.replace(BACKSLASH, '/'))) return false;
	for (const entry of entries) {
		if (same_module_path(entry.componentPath, file)) return true;
	}
	return false;
}

/**
 * Absolute path equality with querystrings stripped (host vs component vs Vite watch paths).
 * @internal
 */
export function same_module_path(a: string | null | undefined, b: string | null | undefined) {
	if (!a || !b) return false;
	return path.resolve(a.split('?')[0]) === path.resolve(b.split('?')[0]);
}

/**
 * Virtual island ids whose generated source must be dropped when `file` changes or is deleted.
 * Island ids are `hash(componentPath\\0strategyKey)` — renaming a host route keeps the same id, so
 * Vite's moduleGraph must be invalidated or it keeps serving the old import.
 *
 * @internal HMR invalidation helper (also covered by unit tests).
 */
export function island_vpaths_affected_by_file(
	file: string,
	entries: Iterable<[string, { hostPath?: string | null; componentPath?: string | null }]>
) {
	const out: string[] = [];
	for (const [vpath, entry] of entries) {
		if (same_module_path(entry.hostPath, file) || same_module_path(entry.componentPath, file)) {
			out.push(vpath);
		}
	}
	return out;
}
