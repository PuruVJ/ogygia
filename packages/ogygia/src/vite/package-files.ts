/**
 * `ogygia.files` — a dependency package DECLARES its ogygia compile surface in its OWN
 * package.json, npm-`files`-style (bare dirs recurse, globs allowed):
 *
 *     { "ogygia": { "files": ["./src/components", "./src/admin-routes.ts", "./dist/**\/*.js"] } }
 *
 * Only declared packages are ever scanned — walking every dependency would be slow AND wrong —
 * and only their declared paths. The consumer configures NOTHING: discovery reads the app's
 * direct dependencies' manifests (a handful of tiny file reads), and the plugin turns each
 * declaration into ssr.noExternal + optimizeDeps.exclude + prescan roots + transform gates.
 *
 * Everything is realpath'd: Vite resolves module ids through symlinks (pnpm), so gate matching
 * must speak real paths or every check silently misses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'tinyglobby';
import type { PackageScan } from '../compiler/ctx.js';

export type { PackageScan };

const posix = (p: string) => p.split(path.sep).join('/');
/** npm-glob magic — a bare path is stat'd, anything magic goes through the glob expander. */
const GLOB_MAGIC_RE = /[*?{}[\]!]/;

function read_manifest(dir: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
}

export function discover_package_files(app_root: string): PackageScan[] {
	const app = read_manifest(app_root);
	if (!app) return [];
	const deps = [
		...Object.keys((app.dependencies as object | undefined) ?? {}),
		...Object.keys((app.devDependencies as object | undefined) ?? {})
	];
	const found: PackageScan[] = [];
	for (const name of deps) {
		// ogygia's own compile surface (profiler UI, …) is wired internally, not via this field
		if (name === 'ogygia') continue;
		const pkg_dir = path.join(app_root, 'node_modules', ...name.split('/'));
		const manifest = read_manifest(pkg_dir);
		const declared = (manifest?.ogygia as { files?: unknown } | undefined)?.files;
		if (declared == null) continue;
		if (!Array.isArray(declared) || !declared.every((p) => typeof p === 'string')) {
			throw new Error(
				`[ogygia] ${name}: \`"ogygia": { "files": […] }\` must be an array of package-relative ` +
					`paths/globs (like npm's "files") — got ${JSON.stringify(declared)}.`
			);
		}
		let root: string;
		try {
			root = fs.realpathSync(pkg_dir);
		} catch {
			continue;
		}
		const dirs: string[] = [];
		const files = new Set<string>();
		for (const entry of declared) {
			if (GLOB_MAGIC_RE.test(entry)) {
				for (const m of globSync(entry, { cwd: root, absolute: true, dot: false })) {
					// same escape rule as bare paths — `../…/**` must not widen the surface
					if (!posix(m).startsWith(posix(root) + '/')) continue;
					try {
						files.add(posix(fs.realpathSync(m)));
					} catch {
						/* dangling symlink — skip */
					}
				}
				continue;
			}
			const abs = path.resolve(root, entry);
			// the declaration must stay INSIDE the package — a path escaping it would silently
			// widen the compile surface to unrelated code
			if (abs !== root && !abs.startsWith(root + path.sep)) {
				throw new Error(`[ogygia] ${name}: ogygia.files entry '${entry}' escapes the package.`);
			}
			let stat;
			try {
				stat = fs.statSync(abs);
			} catch {
				console.warn(`[ogygia] ${name}: ogygia.files entry '${entry}' does not exist — skipped.`);
				continue;
			}
			if (stat.isDirectory()) dirs.push(posix(fs.realpathSync(abs)));
			else files.add(posix(fs.realpathSync(abs)));
		}
		if (dirs.length || files.size) {
			found.push({ name, root: posix(root), dirs, files: [...files] });
		}
	}
	return found;
}
