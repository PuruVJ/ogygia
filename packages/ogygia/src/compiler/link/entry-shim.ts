/**
 * THE STABLE-NAME SHIMS. An island entry and the runtime are content-hashed files; each one's old
 * stable name is ALSO written, as a shim of the hashed file, so that a page cached before content
 * hashing (whose islands import their stable names), and a load whose location failed (the runtime
 * re-fetches the stable name fresh), still reach the CURRENT build.
 *
 * A shim is written as a plain ASSET at the bundle's end, once every hashed name is final — never as
 * a bundled chunk. Its name never changes, so the bundler has nothing to hash, and a chunk would make
 * the island's module the target of two entries: the bundler would split its code behind two facades
 * and every island load would cost two requests. As an asset, the island has one entry, its location
 * IS its code, and the shim is a static re-export by relative path.
 */
import { path } from '../host.js';

/** The specifier from the shim's file to the hashed file (both output-relative paths). */
function relative_specifier(from_file: string, to_file: string): string {
	const rel = path.posix.relative(path.posix.dirname(from_file), to_file);
	return rel.startsWith('.') ? rel : './' + rel;
}

/** An island entry's shim: every export of its hashed file (a component entry has a default). */
export function island_shim_source(shim_file: string, entry_file: string): string {
	const spec = JSON.stringify(relative_specifier(shim_file, entry_file));
	return `export * from ${spec};\nexport { default } from ${spec};\n`;
}

/** The runtime's shim: the hashed runtime, run (it has no exports; loading it boots). */
export function runtime_shim_source(shim_file: string, runtime_file: string): string {
	return `import ${JSON.stringify(relative_specifier(shim_file, runtime_file))};\n`;
}
