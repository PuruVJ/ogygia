import { V as escape_html } from '../../../chunks/async.js-JxW4IVMW.js';
import { p as page } from '../../../chunks/state.js-B_7Rd0Ds.js';
import { I as Island } from '../../../chunks/internal3.js-DRIflGiV.js';
import { C as Counter } from '../../../chunks/Counter.js-BNzt6BII.js';
import 'devalue';
import '../../../chunks/internal.js-gg_mc6sK.js';
import '../../../chunks/shared.js-B5OSxjL7.js';
import '../../../chunks/routing.js-poy0Ceuj.js';
import '../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../chunks/utils.js-CNshUuVp.js';
import '../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../chunks/paths.js-CKQC7KeW.js';
import '../../../chunks/payload.js-BiRFERCp.js';

//#region src/routes/kit/.ogygia/8d89ceafc267.svelte
function _d89ceafc267($$renderer) {
	Counter($$renderer, {
		start: 42,
		label: "Island on a csr=true page"
	});
}
//#endregion
//#region src/lib/KitStatus.svelte
function KitStatus($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<div data-kit-status="">normal component, real <code>$app/state</code> — path: <strong>${escape_html(page.url.pathname)}</strong> <button>kit-status count ${escape_html(0)}</button></div>`);
	});
}
//#endregion
//#region src/routes/kit/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav> <hr/> <h1 data-static-shell="">Kit page (csr = true) — coexistence demo</h1> <p data-static-shell="">This page opts into full Kit hydration. The island below still works, but Kit hydrates it
	(exactly once) as a normal component.</p> `);
	Island($$renderer, {
		load: true,
		__entry: "8d89ceafc267",
		__component: _d89ceafc267,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	KitStatus($$renderer);
	$$renderer.push(`<!---->`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-DRJF4UaB.js.map
