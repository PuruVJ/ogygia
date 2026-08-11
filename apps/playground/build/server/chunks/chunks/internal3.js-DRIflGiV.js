import './internal.js-gg_mc6sK.js';
import { d as building } from './internal2.js-CRcS4Hsm.js';
import { Y as spread_props, X as attr, Z as html, G as createContext } from './async.js-JxW4IVMW.js';
import { a as asset, r as resolve } from './paths.js-CKQC7KeW.js';
import { p as page } from './state.js-B_7Rd0Ds.js';
import { a as b64urlEncode, c as sign, s as secret } from './payload.js-BiRFERCp.js';
import { stringify } from 'devalue';

//#region \0virtual:ogygia/runtime-url
var runtime_url_default = "/_app/immutable/ogygia-runtime.1a98ad6dae61.js";
//#endregion
//#region ../packages/ogygia/dist/context.js
var [get_nested_context, set_nested_context] = createContext();
/** Mark the current subtree as living inside an island (called by a top-level wrapper/provider). */
function setNested() {
	set_nested_context(true);
}
/**
* True when an ancestor island wrapper already marked the subtree. `createContext`'s getter
* throws when no ancestor set it (a top-level island) — that absence is exactly "not nested".
*/
function isNested() {
	try {
		return get_nested_context() === true;
	} catch {
		return false;
	}
}
//#endregion
//#region ../packages/ogygia/dist/Island.svelte
function Island($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/**
		* @typedef {Object} Props
		* @property {boolean|string} [visible] hydrate when scrolled into view (string = IntersectionObserver root_margin)
		* @property {boolean} [idle] hydrate on requestIdleCallback
		* @property {string} [media] hydrate when the media query matches
		* @property {boolean} [load] hydrate immediately (default)
		* @property {string} __entry island id
		* @property {import('svelte').Component<Record<string, unknown>>} __component the extracted island component
		* @property {Record<string, unknown>} __props captured props
		*/
		/** @type {Props} */
		let { visible, idle, media, load, __entry, __component: Component, __props } = $$props;
		const nested = isNested();
		if (!nested) setNested();
		const hydrate_attr = media ? media : idle ? "idle" : visible ? "visible" : "load";
		const root_margin = typeof visible === "string" ? visible : void 0;
		const LT = String.fromCharCode(60);
		const props_script = "<script type=\"application/ogygia-props\" data-ogygia-props>" + (nested ? "" : stringify(__props).split(LT).join("\\u003C")) + "<\/script>";
		function page_snapshot() {
			const b = {
				url: page.url?.href,
				params: page.params,
				route: page.route,
				status: page.status
			};
			try {
				const full = {
					...b,
					data: page.data,
					form: page.form ?? null,
					error: page.error ?? null
				};
				return stringify(full).split(LT).join("\\u003C");
			} catch {
				return stringify(b).split(LT).join("\\u003C");
			}
		}
		const page_script = nested ? "" : "<script type=\"application/ogygia-page\" data-ogygia-page>" + page_snapshot() + "<\/script>";
		const runtime_script = "<script type=\"module\" src=\"" + asset(runtime_url_default) + "\"><\/script>";
		if (nested) {
			$$renderer.push("<!--[0-->");
			if (Component) {
				$$renderer.push("<!--[-->");
				Component($$renderer, spread_props([__props]));
				$$renderer.push("<!--]-->");
			} else {
				$$renderer.push("<!--[!-->");
				$$renderer.push("<!--]-->");
			}
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<ogygia-region${attr("entry", __entry)}${attr("hydrate", hydrate_attr)}${attr("margin", root_margin || void 0)}>`);
			if (Component) {
				$$renderer.push("<!--[-->");
				Component($$renderer, spread_props([__props]));
				$$renderer.push("<!--]-->");
			} else {
				$$renderer.push("<!--[!-->");
				$$renderer.push("<!--]-->");
			}
			$$renderer.push(`</ogygia-region>${html(props_script)}${html(page_script)}${html(runtime_script)}`);
		}
		$$renderer.push(`<!--]-->`);
	});
}
//#endregion
//#region ../packages/ogygia/dist/server/endpoint.js
var DEFAULT_ISLANDS_ENDPOINT = "/🏝️ogygia🏝️";
//#endregion
//#region ../packages/ogygia/dist/ServerIsland.svelte
function ServerIsland($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		/**
		* @typedef {Object} Props
		* @property {string} __entry island id (manifest key on the server)
		* @property {import('svelte').Component<Record<string, unknown>>} [__component] island component — imported by the host purely so its CSS
		*   lands in the page import graph; NOT rendered here (the endpoint renders it).
		* @property {Record<string, unknown>} __props captured props (server-rendered with these)
		* @property {import('svelte').Snippet} [fallback] rendered into the page immediately
		*/
		/** @type {Props} */
		let { __entry, __component: Component, __props, fallback } = $$props;
		const nested = isNested();
		if (!nested) setNested();
		const payload = nested ? "" : b64urlEncode(stringify(__props));
		const sig = nested ? "" : sign(secret, payload);
		const endpoint = nested ? "" : `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(__entry)}&props=${payload}&sig=${sig}`;
		const href_attr = endpoint.split("&").join("&amp;");
		const preload_link = nested || building ? "" : "<link rel=\"preload\" as=\"fetch\" href=\"" + href_attr + "\">";
		const runtime_script = "<script type=\"module\" src=\"" + asset(runtime_url_default) + "\"><\/script>";
		if (nested) {
			$$renderer.push("<!--[0-->");
			if (Component) {
				$$renderer.push("<!--[-->");
				Component($$renderer, spread_props([__props]));
				$$renderer.push("<!--]-->");
			} else {
				$$renderer.push("<!--[!-->");
				$$renderer.push("<!--]-->");
			}
		} else {
			$$renderer.push("<!--[-1-->");
			$$renderer.push(`<ogygia-region${attr("entry", __entry)} defer=""${attr("endpoint", endpoint)}>`);
			if (fallback) {
				$$renderer.push("<!--[0-->");
				fallback($$renderer);
				$$renderer.push(`<!---->`);
			} else $$renderer.push("<!--[-1-->");
			$$renderer.push(`<!--]--></ogygia-region>${html(preload_link)}${html(runtime_script)}`);
		}
		$$renderer.push(`<!--]-->`);
	});
}

export { Island as I, ServerIsland as S };
//# sourceMappingURL=internal3.js-DRIflGiV.js.map
