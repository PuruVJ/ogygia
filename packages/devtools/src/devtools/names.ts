/**
 * The islands' component names for the dock and the testing API: a build carries them in
 * `virtual:ogygia/devtools-meta`; the dev server serves them live (`/__ogygia_devtools_meta`, the
 * registry as it is now). Both land on `window.__ogygia_region_names`, which regions.ts reads.
 * Once per page; best effort (a hash stands in for a name it cannot find).
 */
import { names as built_names } from 'virtual:ogygia/devtools-meta';

let loading: Promise<void> | null = null;

export function ensure_region_names(): Promise<void> {
	if (loading) return loading;
	loading = (async () => {
		if (typeof window === 'undefined') return;
		if (built_names && Object.keys(built_names).length) {
			window.__ogygia_region_names = { ...built_names, ...(window.__ogygia_region_names ?? {}) };
			return;
		}
		try {
			const r = await fetch('/__ogygia_devtools_meta');
			if (!r.ok) return;
			const meta = (await r.json()) as { names?: Record<string, string>; bytes?: Record<string, unknown> };
			if (meta?.names) window.__ogygia_region_names = { ...meta.names, ...(window.__ogygia_region_names ?? {}) };
			if (meta?.bytes) (window as unknown as { __ogygia_region_bytes?: unknown }).__ogygia_region_bytes = meta.bytes;
		} catch {
			// no meta endpoint (a build with no names): hashes stand in
		}
	})();
	return loading;
}
