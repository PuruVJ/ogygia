import '../../../chunks/async.js-JxW4IVMW.js';
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

//#region src/routes/plain/.ogygia/bc22aa23df3b.svelte
function Bc22aa23df3b($$renderer) {
	Counter($$renderer, {
		start: 5,
		label: "Plain-page counter"
	});
}
//#endregion
//#region src/routes/plain/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/data">Data</a> <a href="/server">Server</a> <a href="/nested">Nested</a> <a href="/static">Prerendered</a> <a href="/forms">Forms</a> <a href="/dashboard/orders">Dashboard</a> <a href="/plain">Plain (no router)</a></nav> <hr/> <h1 data-static-shell="">Plain page (no ClientRouter)</h1> <p data-static-shell="">Links here trigger real document navigations. The island below still hydrates.</p> `);
	Island($$renderer, {
		load: true,
		__entry: "bc22aa23df3b",
		__component: Bc22aa23df3b,
		__props: {}
	});
	$$renderer.push(`<!---->`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-CuBnjjHO.js.map
