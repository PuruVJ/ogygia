// Ambient declarations for the library's own build-time virtual modules and the Kit modules it
// references. These make `tsc --noEmit` clean; they are not shipped (excluded from tsdown entry).

declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	export const spa: boolean;
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
}
declare module 'virtual:ogygia/server-manifest' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
}
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
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
}
declare module '$app/environment' {
	export const building: boolean;
	export const browser: boolean;
	export const dev: boolean;
}

// Minimal ambient for the one Kit type the library imports (`Handle` in hooks.ts). The lib does
// not depend on @sveltejs/kit; the CONSUMER's real Kit types back the shipped `dist/hooks.d.ts`
// (`@sveltejs/kit` is externalised by tsdown). Not shipped (types.d.ts is excluded from tsdown).
declare module '@sveltejs/kit' {
	export interface RequestEvent {
		url: URL;
		[key: string]: unknown;
	}
	export type Handle = (input: {
		event: RequestEvent;
		resolve: (event: RequestEvent) => Response | Promise<Response>;
	}) => Response | Promise<Response>;
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
