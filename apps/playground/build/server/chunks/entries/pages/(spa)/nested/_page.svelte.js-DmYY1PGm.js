import { V as escape_html } from '../../../../chunks/async.js-JxW4IVMW.js';
import { I as Island, S as ServerIsland } from '../../../../chunks/internal3.js-DRIflGiV.js';
import { B as Be1d4b28abaf } from '../../../../chunks/be1d4b28abaf2.js-CkYUSr3Q.js';
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
import '../../../../chunks/Greeting.js-FtuFdQmi.js';
import '../../../../chunks/server-greeting.remote.js-CHHDI49u.js';
import '../../../../chunks/remote.js-CMrFgAnM.js';

//#region src/lib/Inner.svelte
function Inner($$renderer, $$props) {
	let { label = "inner" } = $$props;
	$$renderer.push(`<button data-inner="">inner ${escape_html(label)}: <span data-inner-n="">${escape_html(0)}</span></button>`);
}
//#endregion
//#region src/lib/.ogygia/c688eb6e330a.svelte
function C688eb6e330a($$renderer) {
	Inner($$renderer, { label: "child" });
}
//#endregion
//#region src/lib/Outer.svelte
function Outer($$renderer, $$props) {
	let { title = "outer" } = $$props;
	$$renderer.push(`<div class="island" data-outer=""><button data-outer-btn="">outer ${escape_html(title)}: <span data-outer-m="">${escape_html(0)}</span></button> `);
	Island($$renderer, {
		visible: "0px",
		__entry: "c688eb6e330a",
		__component: C688eb6e330a,
		__props: {}
	});
	$$renderer.push(`<!----> <div data-nested-server="">`);
	ServerIsland($$renderer, {
		__entry: "be1d4b28abaf",
		__component: Be1d4b28abaf,
		__props: {}
	});
	$$renderer.push(`<!----></div></div>`);
}
//#endregion
//#region src/routes/(spa)/nested/.ogygia/594eeed22bb1.svelte
function _94eeed22bb1($$renderer) {
	Outer($$renderer, { title: "A" });
}
//#endregion
//#region src/routes/(spa)/nested/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<h1 data-static-shell="">Nested islands</h1> <p data-static-shell="">Outer is a <code>load</code> island. Its own source imports Inner as a <code>visible</code> island. Inner degrades to a normal component and hydrates with Outer —
	one hydration, both interactive.</p> `);
	Island($$renderer, {
		load: true,
		__entry: "594eeed22bb1",
		__component: _94eeed22bb1,
		__props: {}
	});
	$$renderer.push(`<!---->`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-DmYY1PGm.js.map
