/**
 * `virtual:ogygia/server-manifest` emitter — the SERVER islands' data the `ogygiaHandle()` handle
 * reads (id → CSS-key url, so a server-picked (held) hole can ship its scoped CSS with its response;
 * names; render identities) and `load_islands()`, the one dynamic import of
 * `virtual:ogygia/server-islands`, which holds each island's loader. Populated in BOTH dev and build
 * (unlike the client manifest, which dev fills from URLs); the client build gets empty maps. A
 * whole-program emitter: it reads the Program's descriptor registry.
 *
 * WHY the loaders sit one dynamic import away: Kit links, eagerly, the CSS of every module a page's
 * SERVER graph reaches within one dynamic import (find_deps, `dynamic_import_depth <= 1`). The
 * bundler co-locates this module with whatever shares it (the handle, `region()`), and a page's
 * component imports that chunk statically — so loaders living here put every island of the app one
 * dynamic import from every page, and a Kit-hydrated page linked them all. Behind `load_islands()`
 * they are two away, whatever the chunking (rolldown 1.2.16 regrouped it and exposed exactly this).
 */
import type { Program } from '../program.ts';
import { V_SERVER_ISLANDS } from '../ids.ts';

/** The SERVER-island ids the manifest carries right now (deferred / server-picked regions). */
export function server_island_ids(program: Program): string[] {
	const ids: string[] = [];
	for (const [iid, virtualPath] of program.by_id) {
		if (program.registry.get(virtualPath)?.server) ids.push(iid);
	}
	return ids;
}

export function server_manifest_module(
	ssr: boolean,
	program: Program,
	is_dev: boolean,
	devUrlFor: (virtualPath: string) => string,
	publicUrlFor: (iid: string) => string
): string {
	if (!ssr)
		return `export const load_islands = () => Promise.resolve({ islands: {} });\nexport const island_url = {};\nexport const island_name = {};\nexport const island_render = {};\nexport const render_island = {};\nexport const island_reads_page_data = null;`;
	const urls: string[] = [];
	const names: string[] = [];
	const renders: string[] = [];
	/** render id → the server entry that renders it (the smallest id: one answer per build) */
	const by_render = new Map<string, string>();
	for (const [iid, virtualPath] of program.by_id) {
		const reg = program.registry.get(virtualPath);
		if (!reg?.server) continue;
		// id → its render identity, signed into every capability minted for it; render identity → an
		// entry rendering it, for a capability minted by another build (compiler/region/identity.ts)
		if (reg.renderId) {
			renders.push(`  ${JSON.stringify(iid)}: ${JSON.stringify(reg.renderId)}`);
			const seen = by_render.get(reg.renderId);
			if (seen === undefined || iid < seen) by_render.set(reg.renderId, iid);
		}
		// id → its component's name (`SlowHole` from `…/SlowHole.svelte`): the profiler names a hole
		// request by it (neither URL carries the name: both are keyed by the id)
		const file = reg.componentPath ?? '';
		const base = file.slice(file.lastIndexOf('/') + 1);
		if (base.endsWith('.svelte'))
			names.push(`  ${JSON.stringify(iid)}: ${JSON.stringify(base.slice(0, -7))}`);
		// id → the URL `islandCss()` is keyed by, so the handle can ship a server-picked hole's
		// CSS with its response (a page that never imported the component still styles it). In a
		// build that's the hashed client chunk (→ handoff CSS assets); in dev it's the entry's
		// dev module URL (→ `islandCss` returns it, the client imports it for CSS). Same channel.
		urls.push(
			`  ${JSON.stringify(iid)}: ${JSON.stringify(is_dev ? devUrlFor(virtualPath) : publicUrlFor(iid))}`
		);
	}
	return (
		`export const load_islands = () => import(${JSON.stringify(V_SERVER_ISLANDS)});\n` +
		`export const island_url = {\n${urls.join(',\n')}\n};\n` +
		`export const island_name = {\n${names.join(',\n')}\n};\n` +
		`export const island_render = {\n${renders.join(',\n')}\n};\n` +
		`export const render_island = {\n${[...by_render].map(([r, iid]) => `  ${JSON.stringify(r)}: ${JSON.stringify(iid)}`).join(',\n')}\n};\n` +
		// id → does the hole's SERVER tree read `page.data` (the page lookup a hole needs: server/
		// render-page.ts). Known only once every module is transformed: a build patches the
		// placeholder in renderChunk (driver `patch_page_data_reads`); dev leaves `null` (unknown → look up).
		`export const island_reads_page_data = ${is_dev ? 'null' : PAGE_DATA_READS_PLACEHOLDER};`
	);
}

/** `virtual:ogygia/server-islands`: each SERVER island's loader, `id → () => import(entry)` (empty on
 *  the client). Imported only by the manifest's `load_islands()` — never statically. */
export function server_islands_module(ssr: boolean, program: Program): string {
	const entries: string[] = [];
	if (ssr)
		for (const [iid, virtualPath] of program.by_id)
			if (program.registry.get(virtualPath)?.server)
				entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
	return `export const islands = {\n${entries.join(',\n')}\n};\n`;
}

/** The token the build replaces with its answer (driver `patch_page_data_reads`), inside a string
 *  literal the bundler cannot fold: a plain `null` placeholder was inlined into every reader as the
 *  constant it was (every hole then looked its page up). Unpatched it parses to nothing → `null`. */
export const PAGE_DATA_READS_TOKEN = '__OGYGIA_PAGE_DATA_READS__';
export const PAGE_DATA_READS_PLACEHOLDER: `(() => { try { return JSON.parse("${typeof PAGE_DATA_READS_TOKEN}"); } catch { return null; } })()` = `(() => { try { return JSON.parse("${PAGE_DATA_READS_TOKEN}"); } catch { return null; } })()`;
