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
