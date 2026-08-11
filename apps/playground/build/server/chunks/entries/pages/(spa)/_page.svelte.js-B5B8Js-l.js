import { _ as ensure_array_like, V as escape_html } from '../../../chunks/async.js-JxW4IVMW.js';
import { I as Island } from '../../../chunks/internal3.js-DRIflGiV.js';
import { C as Counter } from '../../../chunks/Counter.js-BNzt6BII.js';
import 'devalue';
import '../../../chunks/internal.js-gg_mc6sK.js';
import '../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../chunks/paths.js-CKQC7KeW.js';
import '../../../chunks/routing.js-poy0Ceuj.js';
import '../../../chunks/utils.js-CNshUuVp.js';
import '../../../chunks/shared.js-B5OSxjL7.js';
import '../../../chunks/state.js-B_7Rd0Ds.js';
import '../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../chunks/payload.js-BiRFERCp.js';

//#region src/routes/(spa)/.ogygia/bd489eb7de1a.svelte
function Bd489eb7de1a($$renderer) {
	Counter($$renderer, {
		start: 10,
		label: "Import-attribute counter"
	});
}
//#endregion
//#region src/lib/DevalueProps.svelte
function DevalueProps($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { date, map, set, big, nested } = $$props;
		$$renderer.push(`<div class="island" data-devalue=""><div data-date="">date instanceof Date: ${escape_html(String(date instanceof Date))} — ${escape_html(date.toISOString())}</div> <div data-map="">map instanceof Map: ${escape_html(String(map instanceof Map))} — size ${escape_html(map.size)}, a=${escape_html(map.get("a"))}</div> <div data-set="">set instanceof Set: ${escape_html(String(set instanceof Set))} — has(2)=${escape_html(String(set.has(2)))}</div> <div data-big="">bigint: ${escape_html(big)} (typeof ${escape_html(typeof big)})</div> <div data-nested="">nested.deep.value: ${escape_html(nested.deep.value)}</div> <button>revived? ${escape_html(String(false))}</button></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/.ogygia/d1cb310755b2.svelte
function D1cb310755b2($$renderer, $$props) {
	let { date, map, set, big, nested } = $$props;
	DevalueProps($$renderer, {
		date,
		map,
		set,
		big,
		nested
	});
}
//#endregion
//#region src/lib/SnippetChildren.svelte
function SnippetChildren($$renderer, $$props) {
	let { title, header, children } = $$props;
	let bumped = 0;
	$$renderer.push(`<div class="island" data-snippet-island=""><h3>${escape_html(title)}</h3> <div data-header="">`);
	header?.($$renderer);
	$$renderer.push(`<!----></div> <div data-children="">`);
	children?.($$renderer);
	$$renderer.push(`<!----></div> <button>bump ${escape_html(bumped)}</button></div>`);
}
//#endregion
//#region src/routes/(spa)/.ogygia/99d455c6a9d6.svelte
function _9d455c6a9d6($$renderer, $$props) {
	let { title, y } = $$props;
	{
		function header($$renderer) {
			$$renderer.push(`<em>header snippet sees outer var y = ${escape_html(y)}</em>`);
		}
		SnippetChildren($$renderer, {
			title,
			header,
			children: ($$renderer) => {
				$$renderer.push(`<span>children content, y doubled = ${escape_html(y * 2)}</span>`);
			}});
	}
}
//#endregion
//#region src/lib/EachItem.svelte
function EachItem($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { item, index } = $$props;
		$$renderer.push(`<div class="island" data-each-island="">Item #${escape_html(index)}: <strong>${escape_html(item.name)}</strong> (score ${escape_html(item.score)}) <button>+${escape_html(0)}</button></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/.ogygia/05f86f4a8b66.svelte
function _5f86f4a8b66($$renderer, $$props) {
	let { item, index } = $$props;
	EachItem($$renderer, {
		item,
		index
	});
}
//#endregion
//#region src/lib/MediaBox.svelte
function MediaBox($$renderer, $$props) {
	let { query = "" } = $$props;
	$$renderer.push(`<div class="island" data-media-island=""><strong>media</strong> island (<code>${escape_html(query)}</code>) <button>taps ${escape_html(0)}</button></div>`);
}
//#endregion
//#region src/routes/(spa)/.ogygia/f46ead6f0b0a.svelte
function F46ead6f0b0a($$renderer) {
	MediaBox($$renderer, { query: "(max-width: 600px)" });
}
//#endregion
//#region src/lib/Visible.svelte
function Visible($$renderer, $$props) {
	let { note = "" } = $$props;
	let clicks = 0;
	if (typeof window !== "undefined") console.log("[ogygia] visible island hydrated:", note);
	$$renderer.push(`<div class="island" data-visible-island="">Below-the-fold <strong>visible</strong> island hydrated. ${escape_html(note)} <button>clicked ${escape_html(clicks)}</button></div>`);
}
//#endregion
//#region src/routes/(spa)/.ogygia/324a681129d9.svelte
function _24a681129d9($$renderer) {
	Visible($$renderer, { note: "(import attribute, visible)" });
}
//#endregion
//#region src/routes/(spa)/.ogygia/b6f4a1ce9736.svelte
function B6f4a1ce9736($$renderer) {
	Counter($$renderer, {
		start: 99,
		label: "Same module, visible strategy"
	});
}
//#endregion
//#region src/routes/(spa)/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const title = "Snippet island";
		const y = 42;
		const date = /* @__PURE__ */ new Date("2024-01-02T03:04:05.678Z");
		const map = /* @__PURE__ */ new Map([["a", 1], ["b", 2]]);
		const set = /* @__PURE__ */ new Set([
			1,
			2,
			3
		]);
		const big = 9007199254740993n;
		const nested = { deep: {
			value: "nested-ok",
			when: /* @__PURE__ */ new Date("2020-05-05T00:00:00.000Z")
		} };
		const items = [
			{
				name: "Alpha",
				score: 1
			},
			{
				name: "Bravo",
				score: 2
			},
			{
				name: "Charlie",
				score: 3
			}
		];
		$$renderer.push(`<h1 data-static-shell="">ogygia playground</h1> <p data-static-shell="">This shell text is server-rendered and never hydrated. The page ships zero Kit JS (<code>csr = false</code>). Only the islands below hydrate.</p> `);
		Island($$renderer, {
			load: true,
			__entry: "bd489eb7de1a",
			__component: Bd489eb7de1a,
			__props: {}
		});
		$$renderer.push(`<!----> `);
		Island($$renderer, {
			load: true,
			__entry: "d1cb310755b2",
			__component: D1cb310755b2,
			__props: {
				date,
				map,
				set,
				big,
				nested
			}
		});
		$$renderer.push(`<!----> `);
		Island($$renderer, {
			load: true,
			__entry: "99d455c6a9d6",
			__component: _9d455c6a9d6,
			__props: {
				title,
				y
			}
		});
		$$renderer.push(`<!----> <!--[-->`);
		const each_array = ensure_array_like(items);
		for (let index = 0, $$length = each_array.length; index < $$length; index++) {
			let item = each_array[index];
			Island($$renderer, {
				load: true,
				__entry: "05f86f4a8b66",
				__component: _5f86f4a8b66,
				__props: {
					item,
					index
				}
			});
		}
		$$renderer.push(`<!--]--> `);
		Island($$renderer, {
			media: "(max-width: 600px)",
			__entry: "f46ead6f0b0a",
			__component: F46ead6f0b0a,
			__props: {}
		});
		$$renderer.push(`<!----> <div class="spacer">scroll down to hydrate the visible islands…</div> `);
		Island($$renderer, {
			visible: "0px",
			__entry: "324a681129d9",
			__component: _24a681129d9,
			__props: {}
		});
		$$renderer.push(`<!----> `);
		Island($$renderer, {
			visible: "0px",
			__entry: "b6f4a1ce9736",
			__component: B6f4a1ce9736,
			__props: {}
		});
		$$renderer.push(`<!---->`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-B5B8Js-l.js.map
