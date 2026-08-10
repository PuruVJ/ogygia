declare module '$app/server' {
	// Ambient stubs for library typecheck/build — real types come from the Kit app.
	export function prerender(...args: unknown[]): unknown;
	export const query: ((...args: unknown[]) => unknown) & {
		live: (...args: unknown[]) => unknown;
		batch: (...args: unknown[]) => unknown;
	};
}
