import '../../../../chunks/async.js-JxW4IVMW.js';
import { S as ServerIsland } from '../../../../chunks/internal3.js-DRIflGiV.js';
import { D as Defe9ef21fd5 } from '../../../../chunks/defe9ef21fd52.js-CKZA79RW.js';
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

//#region src/routes/(spa)/server/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<h1 data-static-shell="">Server islands</h1> <p data-static-shell="">The greeting below is a server island. Its fallback renders in the initial HTML; the runtime
	then fetches the rendered component from <code>/_islands</code> (cookie-personalized, slow data)
	and swaps it in. No component JS ships to the browser.</p> `);
	{
		function fallback($$renderer) {
			$$renderer.push(`<p class="fallback svelte-lt1goa" data-fallback="">loading greeting…</p>`);
		}
		ServerIsland($$renderer, {
			__entry: "defe9ef21fd5",
			__component: Defe9ef21fd5,
			__props: {},
			fallback});
	}
	$$renderer.push(`<!---->`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-C8CV0I35.js.map
