/**
 * Library-declared island roots — zero-config discovery of islands that ship INSIDE a dependency.
 *
 * The app's own islands need nothing: marks are file-local at the import site, so the `src` prescan
 * walk finds every island an app page (or a future handle-served page) uses — including third-party
 * components the app marks itself. The ONE case that walk can't reach is a library whose islands are
 * marked inside its own files and rendered only from server code (`document()` pages: the profiler's
 * UI today, any library-shipped UI tomorrow) — those components never enter the client graph, so
 * their hydrate chunks would never build.
 *
 * So a library that ships such islands declares them in its own package.json:
 *
 *     "ogygia": { "islands": ["./src/profiler/ui", "./dist/profiler/ui"] }
 *
 * and the plugin walks every DIRECT dependency's manifest for that field. Entries resolve against
 * the dependency's package root; the FIRST entry that exists on disk wins (so a workspace-linked
 * package lists its live `src` before the shipped `dist` and never double-registers the same
 * components under two paths). No app config, no plugin option — the dependency graph is the
 * declaration.
 *
 * Cost: one package.json read per direct dependency, once per build/dev-server start.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The manifest field: `"ogygia": { "islands": string | string[] }` in a dependency's package.json. */
interface OgygiaManifest {
	ogygia?: { islands?: string | string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function read_manifest(file: string): OgygiaManifest | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as OgygiaManifest;
	} catch {
		return null;
	}
}

/**
 * Collect island roots declared by the app's direct dependencies. `root` is the app root (where its
 * package.json lives). Resolution goes straight through `node_modules/<dep>/package.json` — a plain
 * file read follows pnpm/workspace symlinks and sidesteps `exports` restrictions that can make
 * `require.resolve('<dep>/package.json')` throw.
 */
export function library_island_roots(root: string): string[] {
	const app = read_manifest(path.join(root, 'package.json'));
	if (!app) return [];
	const deps = Object.keys({ ...app.dependencies, ...app.devDependencies });
	const roots: string[] = [];
	for (const dep of deps) {
		// realpath: pnpm/workspaces symlink direct deps, and Vite resolves modules to their REAL path —
		// the walk must register the same real paths or the emitted chunk ids won't match the ids the
		// SSR-side transform mints (entry URL → 404).
		let pkg_dir: string;
		try {
			pkg_dir = fs.realpathSync(path.join(root, 'node_modules', dep));
		} catch {
			continue; // not installed (optional dep, workspace filter)
		}
		const manifest = read_manifest(path.join(pkg_dir, 'package.json'));
		const declared = manifest?.ogygia?.islands;
		if (!declared) continue;
		const entries = Array.isArray(declared) ? declared : [declared];
		// First existing entry wins — src (workspace-linked, live) over dist (published, shipped).
		for (const entry of entries) {
			if (typeof entry !== 'string') continue;
			const dir = path.resolve(pkg_dir, entry);
			// The resolved dir must stay inside the package — a manifest can't point the walk at
			// arbitrary directories on the host.
			if (!dir.startsWith(path.resolve(pkg_dir) + path.sep)) continue;
			if (fs.existsSync(dir)) {
				roots.push(dir);
				break;
			}
		}
	}
	return roots;
}
