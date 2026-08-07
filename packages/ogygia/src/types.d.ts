// Ambient declarations for the library's own build-time virtual modules and the Kit modules it
// references. These make `tsc --noEmit` clean; they are not shipped (excluded from tsdown entry).

declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	/**
	 * Legacy empty stub. Hydrate islands load via `<ogygia-region entry>` module URLs;
	 * this map is no longer populated.
	 */
	export const regions: Record<
		string,
		{ kind: 'hydrate' | 'defer' | 'lake'; load?: () => Promise<{ default: unknown }> }
	>;
}
declare module 'virtual:ogygia/region-endpoint' {
	export function makeRegionEndpoint(entry: string, props?: Record<string, unknown>): string;
}
declare module 'virtual:ogygia/server-manifest' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
}
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/island-deps' {
	/** Public URLs of hashed dependency chunks for a hydrate island entry (`/_app/immutable/…`). */
	export function islandDeps(entry: string): string[];
}
declare module 'virtual:ogygia/dev-hmr' {
	/* side-effect only — CSS HMR bridge under csr=false */
}
declare module 'virtual:ogygia/dev-hmr-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
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
declare module 'virtual:ogygia/rate-limit' {
	/** `max: 0` disables. Baked from `ogygia({ rateLimit })`. */
	export const rateLimit: { max: number; windowMs: number };
}
declare module 'virtual:ogygia/session-cookie' {
	/** Cookie name sealed into the region MAC, or '' when unbound. From `ogygia({ sessionCookie })`. */
	export const sessionCookie: string;
}
declare module 'virtual:ogygia/region-ttl' {
	/** Capability URL TTL in seconds. From `ogygia({ regionTtl })` (default 3600). */
	export const regionTtl: number;
}
declare module 'virtual:ogygia/transport' {
	export const transport: Record<string, { encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }>;
}
declare module 'virtual:ogygia/kit-wire' {
	export function stringify_remote_arg(value: unknown, transport: unknown): string;
	export function stringify_command_arg(value: unknown, transport: unknown): Promise<string>;
	export function create_remote_key(id: string, payload: string): string;
}

declare module '$app/paths' {
	export const base: string;
	export const assets: string;
	export function resolve(id: string, params?: Record<string, string>): string;
	export function asset(file: string): string;
}
declare module '$app/environment' {
	export const building: boolean;
	export const browser: boolean;
	export const dev: boolean;
}
declare module '$app/server' {
	export function getRequestEvent(): {
		cookies: { get: (name: string) => string | undefined };
		[key: string]: unknown;
	};
}

// Minimal ambient for the one Kit type the library imports (`Handle` in hooks.ts). The lib does
// not depend on @sveltejs/kit; the CONSUMER's real Kit types back the shipped `dist/hooks.d.ts`
// (`@sveltejs/kit` is externalised by tsdown). Not shipped (types.d.ts is excluded from tsdown).
declare module '@sveltejs/kit' {
	export interface RequestEvent {
		url: URL;
		[key: string]: unknown;
	}
	export interface ResolveOptions {
		transformPageChunk?: (input: {
			html: string;
			done: boolean;
		}) => string | undefined | Promise<string | undefined>;
	}
	export type Handle = (input: {
		event: RequestEvent;
		resolve: (event: RequestEvent, opts?: ResolveOptions) => Response | Promise<Response>;
	}) => Response | Promise<Response>;
}

// Kit's INTERNAL server request store (deep import, same posture as the vite deep-imports).
// `get_request_store()` returns the live per-request state; `state.remote` is the map Kit
// populates during a csr=false render but only serializes when csr===true (see hooks.ts). Only
// the fields the flicker-seeding path reads are declared. Not shipped (types.d.ts excluded).
declare module '@sveltejs/kit/internal/server' {
	export interface RemoteInternals {
		id: string;
		type: string;
	}
	export interface RequestRemoteState {
		implicit: Map<RemoteInternals, Record<string, () => Promise<unknown>>> | null;
		data: Map<RemoteInternals, Record<string, Promise<unknown>>> | null;
	}
	export interface RequestState {
		transport?: Record<string, { encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }>;
		remote: RequestRemoteState;
	}
	export interface RequestStore {
		event: unknown;
		state: RequestState;
	}
	export function get_request_store(): RequestStore;
	export function try_get_request_store(): RequestStore | null;
}

interface Window {
	// Test-only observability marker: set once per full document load, unchanged across SPA
	// navigations (the module is not re-evaluated), so the browser suites can prove a swap was a
	// client-side nav vs a real reload. Read by Playwright `page.evaluate` (a separate script
	// boundary), so it must be a string-keyed global. NOT used by any library logic.
	__marker?: number;
}

// Rune globals used by the `.svelte.ts` shims. Those files are compiled by the CONSUMER's
// svelte pipeline (which understands runes); this ambient declaration only satisfies the
// library's own plain `tsc` type-check. Not shipped (types.d.ts is excluded from tsdown).
declare function $state<T>(initial: T): T;
