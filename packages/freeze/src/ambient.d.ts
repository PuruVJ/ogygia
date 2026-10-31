// SvelteKit's `$app/env` (Kit ≥ 2.70 and Kit 3), resolved by the app's own Kit at build time.
declare module '$app/env' {
	export const building: boolean;
	export const dev: boolean;
}
