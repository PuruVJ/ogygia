/**
 * Dev-only CSS scope ownership — walks UP the Vite dev module graph to find which top-level route
 * scopes can reach a changed stylesheet, so the soft-CSS-HMR bridge joins a file only on the pages
 * whose sub-app actually owns it. Pure over the graph nodes it is handed; reads, never mutates.
 */
import path from 'node:path';

/** Structural shape of a Vite dev module-graph node (the two fields the owner walk reads). */
export type DevGraphModule = { file?: string | null; importers?: Iterable<DevGraphModule> };

/**
 * Which top-level route scopes can reach `abs_file` — walked UP the dev module graph until route
 * files are hit. A scope is a route file's first path segment under `src/routes` (`'(docs)'`,
 * `'playground'`, `''` for a root-level route file). `[]` = no route owner found; the client treats
 * that as shared and joins anywhere (the safe default for exotic graphs).
 *
 * @internal Exported for unit tests.
 */
export function derive_css_scope_owners(
	abs_file: string,
	root: string,
	graphs: Array<
		| { getModulesByFile?: (f: string) => Set<DevGraphModule> | undefined }
		| undefined
		| null
	>
): string[] {
	const routes_dir = path.join(root, 'src', 'routes') + path.sep;
	const owners = new Set<string>();
	const seen = new Set<DevGraphModule>();
	const stack: DevGraphModule[] = [];
	for (const g of graphs) {
		for (const m of g?.getModulesByFile?.(abs_file) ?? []) stack.push(m);
	}
	let steps = 0;
	while (stack.length && steps++ < 5000) {
		const mod = stack.pop()!;
		if (seen.has(mod)) continue;
		seen.add(mod);
		const f = mod.file ? path.normalize(mod.file) : null;
		if (f && f.startsWith(routes_dir)) {
			const seg = f.slice(routes_dir.length).split(path.sep)[0] ?? '';
			owners.add(seg.includes('.') ? '' : seg); // a route FILE at routes root → the '' scope
			continue; // a route file is an owner — no need to climb past it
		}
		for (const imp of mod.importers ?? []) stack.push(imp);
	}
	return [...owners].sort();
}
