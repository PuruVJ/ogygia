/**
 * A tiny ESM wrapper around `path-browserify` for the Observatory's `node:path` shim. path-browserify
 * is CommonJS: importing its raw file directly (as the node-shims plugin did with an absolute path)
 * works in `build` (the bundler synthesizes a `default`) but CRASHES in `dev` — Vite serves the raw
 * CJS file without a `default` export, so `import path from 'node:path'` throws "no export named
 * 'default'". Routing through this SOURCE module instead lets Vite's dep-optimizer interop it in both
 * realms: the bare `import` below is optimized (default synthesized), and we re-export default + the
 * named members ogygia's transform reaches for.
 */
import path from 'path-browserify';

export default path;
export const {
	join,
	resolve,
	dirname,
	basename,
	extname,
	relative,
	sep,
	normalize,
	isAbsolute,
	parse,
	format,
	posix,
	delimiter
} = path;
