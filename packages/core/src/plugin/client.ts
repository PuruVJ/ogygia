/**
 * `ogygia/plugin/client` — the BROWSER realm of a plugin (design: internal/notes/packages.md, plugin
 * API v2). A plugin package exports `./client`; its default export is `defineClient({ … })`. The
 * build finds it by the plugin's name and imports it statically into the runtime's boot entry, so it
 * ships to every page the runtime boots on. Keep it small: it is in the boot's static graph — load
 * anything heavy with a dynamic import of its own, on demand.
 *
 *   export default defineClient({
 *     boot({ kitPage }) { … },                  // once, as the runtime boots (before any region wakes)
 *     regionMount(el, { entry, urls }) { … },  // a region's component started in the browser
 *     regionUnmount(el, { entry }) { … }       // …and left the page
 *   });
 *
 * With no plugin's client realm in the build, core's calls into these fold away entirely.
 */

/** What `boot` is told about the page. */
export interface ClientBootContext {
	/** A page Kit hydrates (csr = true): ogygia's runtime does not boot there and no region hook
	 *  fires; the realm boots on its own (dev only). */
	readonly kitPage: boolean;
}

/** A region whose component runs in the browser, as the region hooks see it. */
export interface ClientRegion {
	/** The region's entry (its component's stable module URL). */
	readonly entry: string;
}

/** A plugin's browser half. */
export interface ClientPlugin {
	/** Once, as the runtime boots: after core's features, before the first region wakes. */
	boot?(ctx: ClientBootContext): void;
	/** A region's component started (hydrated, or mounted live). `urls`: the files it runs from. */
	regionMount?(el: Element, region: ClientRegion & { readonly urls: readonly string[] }): void;
	/** A region's component left the page. */
	regionUnmount?(el: Element, region: ClientRegion): void;
}

/** Typed identity: a plugin's browser half. */
export function defineClient(plugin: ClientPlugin): ClientPlugin {
	return plugin;
}
