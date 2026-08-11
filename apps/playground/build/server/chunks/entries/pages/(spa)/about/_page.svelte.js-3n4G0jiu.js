import { V as escape_html } from '../../../../chunks/async.js-JxW4IVMW.js';
import { I as Island } from '../../../../chunks/internal3.js-DRIflGiV.js';
import { C as Counter } from '../../../../chunks/Counter.js-BNzt6BII.js';
import 'devalue';
import '../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../../chunks/paths.js-CKQC7KeW.js';
import '../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../chunks/utils.js-CNshUuVp.js';
import '../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../chunks/state.js-B_7Rd0Ds.js';
import '../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../chunks/payload.js-BiRFERCp.js';

//#region src/lib/Clock.svelte
function Clock($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let time = (/* @__PURE__ */ new Date()).toLocaleTimeString();
		$$renderer.push(`<div class="island" data-clock-island="">Clock island: <strong>${escape_html(time)}</strong></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/about/.ogygia/9f8bbcd9d642.svelte
function _f8bbcd9d642($$renderer) {
	Clock($$renderer);
}
//#endregion
//#region src/routes/(spa)/about/.ogygia/411ec8005692.svelte
function _11ec8005692($$renderer) {
	Counter($$renderer, {
		start: 100,
		label: "Import-attribute counter (visible)"
	});
}
//#endregion
//#region src/lib/Marker.svelte
function Marker($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<div class="island" data-marker-island="">runtime <code>window.__marker</code>: <span data-marker-value="">${escape_html("(pending)")}</span></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/about/.ogygia/00c3bd02522e.svelte
function _0c3bd02522e($$renderer) {
	Marker($$renderer);
}
//#endregion
//#region src/routes/(spa)/about/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<h1 data-static-shell="">About</h1> <p data-static-shell="">Different page, more islands. Navigating here from Home is a SPA swap.</p> `);
	Island($$renderer, {
		load: true,
		__entry: "9f8bbcd9d642",
		__component: _f8bbcd9d642,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		visible: "0px",
		__entry: "411ec8005692",
		__component: _11ec8005692,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		load: true,
		__entry: "00c3bd02522e",
		__component: _0c3bd02522e,
		__props: {}
	});
	$$renderer.push(`<!----> <p><a href="/">Back home</a> — click it to prove SPA nav keeps <code>window.__marker</code> stable.</p>`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-3n4G0jiu.js.map
