// Ambient types for ogygia's build-time virtual modules. The library ships `.svelte` components
// (ogygia.Router, Island, ServerIsland) that import these; the ogygia vite plugin provides them at
// build time, but a consumer's `svelte-check` needs the declarations to type-check the imports.
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
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
declare module 'virtual:ogygia/sign' {
	export function sign(secret: string, message: string): string;
	export function verify(secret: string, message: string, sig: string): boolean;
	export function region_mac_message(
		id: string,
		exp: number | string,
		props: string,
		session?: string
	): string;
}
declare module 'virtual:ogygia/request-event' {
	export function getRequestEvent(): {
		cookies: { get: (name: string) => string | undefined };
		[key: string]: unknown;
	};
}
declare module 'virtual:ogygia/region-endpoint' {
	export function makeRegionEndpoint(entry: string, props?: Record<string, unknown>): string;
}
