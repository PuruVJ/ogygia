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
