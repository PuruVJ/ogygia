import { V as escape_html, X as attr } from '../../../../chunks/async.js-JxW4IVMW.js';
import { I as Island } from '../../../../chunks/internal3.js-DRIflGiV.js';
import { a as getGreeting, b as getCount, c as clock } from '../../../../chunks/greetings.remote.js-EpnYRFDB.js';
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
import '../../../../chunks/remote.js-CMrFgAnM.js';
import '../../../../chunks/hooks.js-Z54mkQnR.js';
import 'valibot';

//#region src/lib/ResolvedGreeting.svelte
function ResolvedGreeting($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { name } = $$props;
		var res;
		var $$promises = $$renderer.run([async () => res = await getGreeting(name)]);
		$$renderer.push(`<div class="island" data-resolved-greeting=""><strong>Resolved at SSR:</strong> `);
		$$renderer.async([$$promises[0]], ($$renderer) => $$renderer.push(() => escape_html(res.greeting)));
		$$renderer.push(` — computed `);
		$$renderer.async([$$promises[0]], ($$renderer) => $$renderer.push(() => escape_html(res.at.toISOString())));
		$$renderer.push(`</div>`);
	});
}
//#endregion
//#region src/routes/(spa)/data/.ogygia/6aaffa888d2c.svelte
function _aaffa888d2c($$renderer) {
	ResolvedGreeting($$renderer, { name: "world" });
}
//#endregion
//#region src/lib/PendingGreeting.svelte
function PendingGreeting($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<!--[!-->`);
		$$renderer.push(`<div class="island" data-pending="">Loading greeting… (SSR renders this pending snippet)</div>`);
		$$renderer.push(`<!--]-->`);
	});
}
//#endregion
//#region src/routes/(spa)/data/.ogygia/eb2642da8b90.svelte
function Eb2642da8b90($$renderer) {
	PendingGreeting($$renderer);
}
//#endregion
//#region src/lib/RemoteCounter.svelte
function RemoteCounter($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const count = getCount();
		let busy = false;
		$$renderer.push(`<div class="island" data-remote-counter="">`);
		$$renderer.push(`<!--[!-->`);
		$$renderer.push(`<span data-count-pending="">loading count…</span>`);
		$$renderer.push(`<!--]-->`);
		$$renderer.push(` <div data-current="">reactive current: ${escape_html(count.current)}</div> <button data-bump=""${attr("disabled", busy, true)}>bump +1 (command → refresh)</button></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/data/.ogygia/77266d55f87e.svelte
function _7266d55f87e($$renderer) {
	RemoteCounter($$renderer);
}
//#endregion
//#region src/lib/LiveClock.svelte
function LiveClock($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const c = clock();
		$$renderer.push(`<!--[!-->`);
		$$renderer.push(`<div class="island" data-live-pending="">connecting to live clock…</div>`);
		$$renderer.push(`<!--]-->`);
		$$renderer.push(` <div class="island" data-live-current="">latest tick: ${escape_html(c.current)}</div>`);
	});
}
//#endregion
//#region src/routes/(spa)/data/.ogygia/ca1abab8842b.svelte
function Ca1abab8842b($$renderer) {
	LiveClock($$renderer);
}
//#endregion
//#region src/lib/TransportProbe.svelte
function TransportProbe($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<div class="island" data-transport-probe="">`);
		$$renderer.push(`<!--[!-->`);
		$$renderer.push(`<span>loading temperature…</span>`);
		$$renderer.push(`<!--]-->`);
		$$renderer.push(`</div>`);
	});
}
//#endregion
//#region src/routes/(spa)/data/.ogygia/452a9bd82b55.svelte
function _52a9bd82b55($$renderer) {
	TransportProbe($$renderer);
}
//#endregion
//#region src/routes/(spa)/data/+page.svelte
function _page($$renderer) {
	$$renderer.push(`<h1 data-static-shell="">Data — remote functions inside islands</h1> <p data-static-shell="">These islands call SvelteKit remote functions (query with a validated arg, command, and a
	query.live stream) on the client. SSR runs them in-process; hydration re-fetches over HTTP.</p> `);
	Island($$renderer, {
		load: true,
		__entry: "6aaffa888d2c",
		__component: _aaffa888d2c,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		load: true,
		__entry: "eb2642da8b90",
		__component: Eb2642da8b90,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		load: true,
		__entry: "77266d55f87e",
		__component: _7266d55f87e,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		load: true,
		__entry: "ca1abab8842b",
		__component: Ca1abab8842b,
		__props: {}
	});
	$$renderer.push(`<!----> `);
	Island($$renderer, {
		load: true,
		__entry: "452a9bd82b55",
		__component: _52a9bd82b55,
		__props: {}
	});
	$$renderer.push(`<!---->`);
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-gKKDrHmg.js.map
