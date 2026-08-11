import { i as index_server_exports } from './internal.js-gg_mc6sK.js';
import './shared.js-B5OSxjL7.js';
import './routing.js-poy0Ceuj.js';
import { D as getContext, B as noop } from './async.js-JxW4IVMW.js';
import './exports.js-DUO0Cq7p.js';
import './utils.js-CNshUuVp.js';

var is_legacy = noop.toString().includes("$$") || /function \w+\(\) \{\}/.test(noop.toString());
var placeholder_url = "a:";
if (is_legacy) {
	new URL(placeholder_url);
}
//#endregion
//#region ../node_modules/.pnpm/@sveltejs+kit@2.70.2_@sveltejs+vite-plugin-svelte@7.2.0_svelte@5.56.8_vite@8.2.0_@types_b82a031257a225430218912b412880c1/node_modules/@sveltejs/kit/src/runtime/client/client.js
/** @import { RemoteFunctionDataNode, ServerNodesResponse, ServerRedirectNode } from 'types' */
/** @import { CacheEntry } from './remote-functions/cache.svelte.js' */
/** @import { Query } from './remote-functions/query/instance.svelte.js' */
/** @import { LiveQuery } from './remote-functions/query-live/instance.svelte.js' */
var { onMount, tick } = index_server_exports;
//#endregion
//#region ../node_modules/.pnpm/@sveltejs+kit@2.70.2_@sveltejs+vite-plugin-svelte@7.2.0_svelte@5.56.8_vite@8.2.0_@types_b82a031257a225430218912b412880c1/node_modules/@sveltejs/kit/src/runtime/app/state/server.js
function context() {
	return getContext("__request__");
}
//#endregion
//#region ../node_modules/.pnpm/@sveltejs+kit@2.70.2_@sveltejs+vite-plugin-svelte@7.2.0_svelte@5.56.8_vite@8.2.0_@types_b82a031257a225430218912b412880c1/node_modules/@sveltejs/kit/src/runtime/app/state/index.js
/**
* A read-only reactive object with information about the current page, serving several use cases:
* - retrieving the combined `data` of all pages/layouts anywhere in your component tree (also see [loading data](https://svelte.dev/docs/kit/load))
* - retrieving the current value of the `form` prop anywhere in your component tree (also see [form actions](https://svelte.dev/docs/kit/form-actions))
* - retrieving the page state that was set through `goto`, `pushState` or `replaceState` (also see [goto](https://svelte.dev/docs/kit/$app-navigation#goto) and [shallow routing](https://svelte.dev/docs/kit/shallow-routing))
* - retrieving metadata such as the URL you're on, the current route and its parameters, and whether or not there was an error
*
* ```svelte
* <!--- file: +layout.svelte --->
* <script>
* 	import { page } from '$app/state';
* <\/script>
*
* <p>Currently at {page.url.pathname}</p>
*
* {#if page.error}
* 	<span class="red">Problem detected</span>
* {:else}
* 	<span class="small">All systems operational</span>
* {/if}
* ```
*
* Changes to `page` are available exclusively with runes. (The legacy reactivity syntax will not reflect any changes)
*
* ```svelte
* <!--- file: +page.svelte --->
* <script>
* 	import { page } from '$app/state';
* 	const id = $derived(page.params.id); // This will correctly update id for usage on this page
* 	$: badId = page.params.id; // Do not use; will never update after initial load
* <\/script>
* ```
*
* On the server, values can only be read during rendering (in other words _not_ in e.g. `load` functions). In the browser, the values can be read at any time.
*
* @type {import('@sveltejs/kit').Page}
*/
var page = {
	get data() {
		return context().page.data;
	},
	get error() {
		return context().page.error;
	},
	get form() {
		return context().page.form;
	},
	get params() {
		return context().page.params;
	},
	get route() {
		return context().page.route;
	},
	get state() {
		return context().page.state;
	},
	get status() {
		return context().page.status;
	},
	get url() {
		return context().page.url;
	}
};

export { page as p };
//# sourceMappingURL=state.js-B_7Rd0Ds.js.map
