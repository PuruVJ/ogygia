/**
 * The plugins' browser halves, as the runtime calls them (`ogygia/plugin/client`). The boot entry
 * hands them over; every call site sits behind the `__OGYGIA_CLIENT_PLUGINS__` gate, so a build with
 * none folds them away.
 */
import type { ClientPlugin } from '../plugin/client.ts';

export const CLIENT_PLUGINS: boolean =
	typeof __OGYGIA_CLIENT_PLUGINS__ !== 'undefined' ? __OGYGIA_CLIENT_PLUGINS__ : false;

let plugins: readonly ClientPlugin[] = [];

/** Boot each plugin's browser half (the runtime's boot, or a Kit-owned page's). */
export function boot_client_plugins(list: readonly ClientPlugin[], kit_page: boolean): void {
	plugins = list;
	for (const p of list) p.boot?.({ kitPage: kit_page });
}

/** A region's component started in the browser: its entry, and the files it runs from. */
export function client_region_mount(el: Element): void {
	const entry = el.getAttribute('entry');
	if (!entry) return;
	let urls: string[] | undefined;
	for (const p of plugins) {
		if (!p.regionMount) continue;
		urls ??= region_urls(el, entry);
		p.regionMount(el, { entry, urls });
	}
}

/** A region's component left the page. */
export function client_region_unmount(el: Element, entry: string): void {
	for (const p of plugins) p.regionUnmount?.(el, { entry });
}

function region_urls(el: Element, entry: string): string[] {
	const urls: string[] = [];
	for (const u of [entry, el.getAttribute('src')]) {
		try {
			if (u) urls.push(new URL(u, document.baseURI).href);
		} catch {
			/* not a URL */
		}
	}
	return urls;
}
