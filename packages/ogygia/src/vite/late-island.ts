/**
 * WHICH LateIsland Region IMPORTS. An inline island a Kit client navigation created has no component
 * yet; Region renders LateIsland.svelte, which loads it and draws it when it lands — the navigation
 * shows an empty place, then the island (and each island nested in it, one wave at a time).
 *
 * Where the app runs Svelte's async mode, LateIslandAwait.svelte awaits the load instead: the
 * navigation's update batch waits for it, and Kit keeps the old page until the whole new one is in.
 * Without async mode an `await` there does not compile, so Region imports LateIsland.svelte, and the
 * plugin points that one import at LateIslandAwait.svelte only for an app with async mode on.
 */

/** What Region imports, and what it imports instead in an app with async mode on. */
export const LATE_ISLAND_IMPORT = './LateIsland.svelte';
export const LATE_ISLAND_AWAIT_FILE = 'LateIslandAwait.svelte';

/** Does the app compile with Svelte's async mode? Read off vite-plugin-svelte's resolved options (its
 *  config plugin publishes them as `api.options`, resolved before any plugin's own configResolved). */
export function svelte_async_enabled(plugins: readonly { name?: string; api?: unknown }[] | undefined): boolean {
	const api = plugins?.find((p) => p.name === 'vite-plugin-svelte:config')?.api as { options?: { compilerOptions?: { experimental?: { async?: boolean } } } } | undefined;
	return api?.options?.compilerOptions?.experimental?.async === true;
}

/** The file Region's LateIsland import resolves to in an app with async mode on (beside Region,
 *  whichever copy imported it), or null for any other import. */
export function late_island_redirect(source: string, importer: string | undefined, region_modules: ReadonlySet<string>): string | null {
	if (source !== LATE_ISLAND_IMPORT || !importer || !region_modules.has(importer)) return null;
	return importer.slice(0, importer.lastIndexOf('/') + 1) + LATE_ISLAND_AWAIT_FILE;
}
