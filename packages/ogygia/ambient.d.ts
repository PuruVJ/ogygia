// Ambient types for ogygia's build-time virtual modules. The library ships `.svelte`/`.ts` source
// (Region, OgygiaRouter, …) that import these; the ogygia vite plugin provides them at build time,
// but a consumer's `svelte-check`/`tsc` needs the declarations to type-check the imports. Keep in sync
// with packages/ogygia/src/types.d.ts (the library's own build copy).
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/runtime-entry' {
	export const __features: string[];
}
declare module 'virtual:ogygia/dev-hmr' {
	/* side-effect only — CSS HMR bridge under csr=false */
}
declare module 'virtual:ogygia/dev-hmr-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/island-deps' {
	export function islandDeps(entry: string): string[];
}
declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	export const regions: Record<
		string,
		{ kind: 'hydrate' | 'defer' | 'lake'; load?: () => Promise<{ default: unknown }> }
	>;
}
declare module 'virtual:ogygia/server-manifest' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
}
declare module 'virtual:ogygia/region-endpoint' {
	export function makeRegionEndpoint(entry: string, props?: Record<string, unknown>): string;
	export function mintServerIsland(
		entry: string,
		props: Record<string, unknown>,
		ttl?: number
	): string;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
	export const secretStable: boolean;
}
declare module 'virtual:ogygia/sign' {
	export function sign(secret: string, message: string): string;
	export function verify(secret: string, message: string, sig: string): boolean;
	export function region_mac_message(
		id: string,
		exp: number | string,
		props: string,
		session?: string,
		ttl?: number | string
	): string;
}
declare module 'virtual:ogygia/request-event' {
	export function getRequestEvent(): {
		cookies: { get: (name: string) => string | undefined };
		[key: string]: unknown;
	};
}
declare module 'virtual:ogygia/rate-limit' {
	export const rateLimit: { max: number; windowMs: number };
}
declare module 'virtual:ogygia/session-cookie' {
	export const sessionCookie: string;
}
declare module 'virtual:ogygia/region-ttl' {
	export const regionTtl: number;
}
declare module 'virtual:ogygia/transport' {
	export const transport: Record<
		string,
		{ encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }
	>;
}
declare module 'virtual:ogygia/kit-wire' {
	export function stringify_remote_arg(value: unknown, transport: unknown): string;
	export function stringify_command_arg(value: unknown, transport: unknown): Promise<string>;
	export function create_remote_key(id: string, payload: string): string;
}
