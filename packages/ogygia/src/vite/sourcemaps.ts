/**
 * The island-sourcemap sub-plugin — the irreducibly-Vite half of the sourcemap fix (it needs
 * `this.getCombinedSourcemap`). Split out of the adapter's returned array as a factory taking the
 * two things it reads: the `Program` (for the registry row's generated source) and the adapter's
 * `is_island_path` predicate. Kept in `vite/` because it is a Vite `Plugin`, not a driver phase.
 */
import path from 'node:path';
import type { Plugin } from 'vite';
import { strip_id, type Program } from '../compiler/program.js';

/**
 * Rewrite vite-plugin-svelte island sourcemap `sources` so Vite treats them as virtual.
 *
 * Svelte emits the basename of `virtual:ogygia/island/<id>.svelte` (just `<id>.svelte`).
 * That string does not match Vite's `virtualSourceRE`, so `injectSourcesContent` tries a
 * disk read and warns "points to missing source files". Pointing sources back at the
 * full virtual module id silences the warning (and keeps maps coherent).
 *
 * @internal Also covered by unit tests.
 */
export function rewrite_island_sourcemap_sources(
	moduleId: string,
	sources: (string | null)[] | undefined
) {
	if (!sources?.length) return null;
	let changed = false;
	const next = sources.map((s) => {
		if (typeof s !== 'string') return s;
		if (s === moduleId || s.startsWith('virtual:') || s.includes('\0')) return s;
		// Basename-only (or other relative) .svelte source for this virtual module.
		if (s.endsWith('.svelte') && !s.includes('/') && !path.isAbsolute(s)) {
			changed = true;
			return moduleId;
		}
		return s;
	});
	return changed ? next : null;
}

/** The `ogygia:island-sourcemaps` post plugin (Vite flattens it into the adapter's array). */
export function island_sourcemaps_plugin(deps: {
	program: Program;
	is_island_path: (id: string) => boolean;
}): Plugin {
	const { program, is_island_path } = deps;
	return {
		name: 'ogygia:island-sourcemaps',
		enforce: 'post',
		transform(code, id) {
			const bare = strip_id(id);
			if (!is_island_path(bare)) return null;
			// A generated WRAPPER virtual (`virtual:ogygia/wrapper/<hash>.svelte`) is glue with no source
			// on disk. vite-plugin-svelte emits a map whose `sources` is the bare `<hash>.svelte` basename
			// with no `sourcesContent`; Vite then disk-probes it and warns "points to missing source files"
			// — once per island, on every dev page. Rewriting the sources to the virtual id does NOT stick
			// (Vite's `combineSourcemaps` re-traces to svelte's basename map) and inlining `sourcesContent`
			// is lost the same way — so we drop the map for wrappers: Vite skips `injectSourcesContent` when
			// `mappings` is empty, and a wrapper is generated code no one steps through.
			if (bare.includes('/wrapper/')) return { code, map: { mappings: '' } };
			// Other island svelte virtuals (if any): rewrite basename `<hash>.svelte` sources to the full
			// virtual id and inline the generated source as `sourcesContent`.
			let map: {
				version: number;
				mappings: string;
				names: string[];
				sources: (string | null)[];
				sourcesContent?: (string | null)[];
				file?: string;
			};
			try {
				map = this.getCombinedSourcemap();
			} catch {
				return null;
			}
			if (!map?.mappings || !map.sources?.length) return null;
			const rewritten = rewrite_island_sourcemap_sources(bare, map.sources);
			const sources = rewritten ?? map.sources;
			const entry = program.registry.get(bare);
			const base_name = bare.slice(bare.lastIndexOf('/') + 1);
			let injected = false;
			const sourcesContent = sources.map((s, i) => {
				const prev = Array.isArray(map.sourcesContent)
					? (map.sourcesContent as (string | null)[])[i]
					: null;
				if (prev != null) return prev;
				if (entry && (s === bare || s === base_name)) {
					injected = true;
					return entry.source;
				}
				return null;
			});
			if (!rewritten && !injected) return null;
			return {
				code,
				map: { ...map, sources, sourcesContent }
			};
		}
	};
}
