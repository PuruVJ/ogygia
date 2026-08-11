import { W as head, X as attr } from '../../../chunks/async.js-JxW4IVMW.js';
import 'devalue';

//#region ../packages/ogygia/dist/ClientRouter.svelte
function ClientRouter($$renderer, $$props) {
	/**
	* Opt-in SPA router (Astro ClientRouter equivalent). Render this in a layout to
	* enable client-side navigation + view transitions for that section. Without it,
	* links are plain MPA document loads.
	* @typedef {Object} Props
	* @property {boolean} [viewTransitions=true] use the View Transitions API for swaps
	*/
	/** @type {Props} */
	let { viewTransitions = true } = $$props;
	head("5slwsi", $$renderer, ($$renderer) => {
		$$renderer.push(`<meta name="ogygia-router"${attr("content", viewTransitions ? "vt" : "plain")}/>`);
	});
}
//#endregion
//#region src/routes/(spa)/+layout.svelte
function _layout($$renderer, $$props) {
	let { children } = $$props;
	ClientRouter($$renderer, {});
	$$renderer.push(`<!----> <nav><a href="/">Home</a> <a href="/about">About</a> <a href="/data">Data</a> <a href="/server">Server</a> <a href="/nested">Nested</a> <a href="/static">Prerendered</a> <a href="/forms">Forms</a> <a href="/dashboard/orders">Dashboard</a> <a href="/plain">Plain (no router)</a></nav> <hr/> `);
	children($$renderer);
	$$renderer.push(`<!---->`);
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte.js-2Ss5TWaK.js.map
