/**
 * `virtual:ogygia/server-manifest` emitter — the map of SERVER-island id → dynamic import the
 * `ogygiaHandle()` handle uses to render an island server-side, plus the id → CSS-key url map so a
 * server-picked (held) hole can ship its scoped CSS with its response. Populated in BOTH dev and
 * build (unlike the client manifest, which dev fills from URLs); the client build gets an empty map.
 * A whole-program emitter: it reads the Program's descriptor registry.
 */
import type { Program } from '../program.js';

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
	if (!ssr) return `export const islands = {};\nexport const island_url = {};\nexport const island_name = {};`;
	const entries: string[] = [];
	const urls: string[] = [];
	const names: string[] = [];
	for (const [iid, virtualPath] of program.by_id) {
		const reg = program.registry.get(virtualPath);
		if (!reg?.server) continue;
		// id → its component's name (`SlowHole` from `…/SlowHole.svelte`): the profiler names a hole
		// request by it (neither URL carries the name: both are keyed by the id)
		const file = reg.componentPath ?? '';
		const base = file.slice(file.lastIndexOf('/') + 1);
		if (base.endsWith('.svelte')) names.push(`  ${JSON.stringify(iid)}: ${JSON.stringify(base.slice(0, -7))}`);
		entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
		// id → the URL `islandCss()` is keyed by, so the handle can ship a server-picked hole's
		// CSS with its response (a page that never imported the component still styles it). In a
		// build that's the hashed client chunk (→ handoff CSS assets); in dev it's the entry's
		// dev module URL (→ `islandCss` returns it, the client imports it for CSS). Same channel.
		urls.push(
			`  ${JSON.stringify(iid)}: ${JSON.stringify(is_dev ? devUrlFor(virtualPath) : publicUrlFor(iid))}`
		);
	}
	return (
		`export const islands = {\n${entries.join(',\n')}\n};\n` +
		`export const island_url = {\n${urls.join(',\n')}\n};\n` +
		`export const island_name = {\n${names.join(',\n')}\n};`
	);
}
