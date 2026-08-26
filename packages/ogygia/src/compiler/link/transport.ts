/**
 * `virtual:ogygia/transport` emitter — re-exports the app's universal `transport` hook (or an empty
 * map) for the client remote wire codec. Universal hooks are isomorphic, so this is client-safe.
 * Pure over the resolved absolute path to the app's universal hooks module (or null).
 */
export function transport_module(universal_hooks: string | null): string {
	if (universal_hooks) {
		const spec = JSON.stringify(universal_hooks);
		return `import * as hooks from ${spec};\nexport const transport = hooks.transport || {};`;
	}
	return `export const transport = {};`;
}

/**
 * `virtual:ogygia/kit-transport` emitter — the value behind the barrel's `ogygia.transport` (the Kit
 * `transport` hook the app spreads into its universal hooks). GENERATED per-app, not a fixed export:
 * the real `ogygiaTransport` statically pulls the whole codec cluster (wire/store/snippet/fn + region,
 * ~9 kB) since a wired value can nest any other kind. A **pure-island** app crosses NOTHING through
 * Kit's transport, so it gets an empty map and never bundles a decoder it can't use. `app_crosses_wire`
 * is the compiler's own knowledge (a transportable class / portable snippet → the `wire` mark, plus a
 * remote file or a `region`/content import) — never a scan for `ogygia.transport` in app source.
 * `transport_spec` is the resolvable path to ogygia's own `transport.js` (dist).
 */
export function kit_transport_module(app_crosses_wire: boolean, transport_spec: string): string {
	if (!app_crosses_wire) return `export const transport = {};\n`;
	return `export { ogygiaTransport as transport } from ${JSON.stringify(transport_spec)};\n`;
}

// A held region / transportable value can only reach Kit's `transport` hook through a value the app
// PRODUCES with a detectable API: `region()`/`<Region>` (a held region in a load/remote), or a content
// import (`site()`, `remotes()` — content bodies are held regions). Wired classes / portable snippets
// are already caught by the `wire` mark. A file with none of these can't put a transportable on Kit's
// wire — so scanning import CLAUSES is complete, not just conservative. Over-inclusion is the safe
// direction anyway (an unused codec is bytes; a missed one breaks decode). Regexes are module-level.
const OGYGIA_WIRE_NAMED = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]ogygia['"]/g;
const WIRE_API = /\b(?:region|Region|site)\b/;
const OGYGIA_CONTENT_IMPORT = /from\s*['"]ogygia\/content(?:\/[a-z-]+)?['"]/;
const OGYGIA_NS_IMPORT = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]ogygia['"]/;
const NS_WIRE_USAGE = /\b(\w+)\.(?:region|Region|site)\b/g;

/** True when `src` produces a held region / transportable value that can cross Kit's `transport`. */
export function source_crosses_wire(src: string): boolean {
	if (OGYGIA_CONTENT_IMPORT.test(src)) return true;
	OGYGIA_WIRE_NAMED.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OGYGIA_WIRE_NAMED.exec(src))) if (WIRE_API.test(m[1])) return true;
	const ns = OGYGIA_NS_IMPORT.exec(src);
	if (!ns) return false;
	NS_WIRE_USAGE.lastIndex = 0;
	let u: RegExpExecArray | null;
	while ((u = NS_WIRE_USAGE.exec(src))) if (u[1] === ns[1]) return true;
	return false;
}

/**
 * `virtual:ogygia/transportables` emitter — the eager-registration manifest: side-effect-import every
 * module that defines a transportable class so their `[ogygia.wire]` codecs register before any island
 * decodes props. Imported by every island entry (client hydrate AND server render), so an island
 * receiving a transportable prop never has to import the class itself. Empty (a no-op, tree-shaken)
 * when the app has no transportables. `modules` is the Program's set of transportable module paths.
 */
export function transportables_module(modules: Iterable<string>): string {
	const imports: string[] = [];
	for (const abs of modules) imports.push(`import ${JSON.stringify(abs)};`);
	return imports.join('\n') + '\n';
}
