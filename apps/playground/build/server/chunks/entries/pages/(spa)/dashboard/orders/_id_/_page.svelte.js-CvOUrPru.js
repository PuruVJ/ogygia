import { X as attr, $ as stringify$1, V as escape_html, z as derived } from '../../../../../../chunks/async.js-JxW4IVMW.js';
import { p as page } from '../../../../../../chunks/state.js-B_7Rd0Ds.js';
import { I as Island } from '../../../../../../chunks/internal3.js-DRIflGiV.js';
import 'devalue';
import '../../../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../../../chunks/utils.js-CNshUuVp.js';
import '../../../../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../../../../chunks/paths.js-CKQC7KeW.js';
import '../../../../../../chunks/payload.js-BiRFERCp.js';

//#region src/lib/OrderDetail.svelte
function OrderDetail($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { id, order } = $$props;
		$$renderer.push(`<div class="island" data-orderdetail=""><h2>Order #${escape_html(id)} <small>(id + data via page shim)</small></h2> <div data-customer="">Customer: ${escape_html(order.customer)}</div> <div data-total="">Total: ${escape_html(order.total)}</div> <div data-status="">Status: ${escape_html(order.status)}</div> <div data-created="">Created: ${escape_html(order.createdAt.toISOString())}</div> <div data-lineitems="">Line items (Map): ${escape_html(order.lineItems.size)}</div> <div data-city="">Ships to: ${escape_html(order.shipping.address.city)}, ${escape_html(order.shipping.address.country)}</div></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/[id]/.ogygia/23c8791a3f3b.svelte
function _3c8791a3f3b($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		OrderDetail($$renderer, {
			id: page.params.id,
			order: page.data.order
		});
	});
}
//#endregion
//#region src/lib/PageDataProbe.svelte
function PageDataProbe($$renderer, $$props) {
	let { id, customer } = $$props;
	const summary = derived(() => `#${id} for ${customer}`);
	$$renderer.push(`<div class="island" data-pagedata-probe="">Derived from page: ${escape_html(summary())}</div>`);
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/[id]/.ogygia/b0652bf2a7b3.svelte
function B0652bf2a7b3($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		PageDataProbe($$renderer, {
			id: page.params.id,
			customer: page.data.order.customer
		});
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/[id]/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		Island($$renderer, {
			load: true,
			__entry: "23c8791a3f3b",
			__component: _3c8791a3f3b,
			__props: {}
		});
		$$renderer.push(`<!----> `);
		Island($$renderer, {
			load: true,
			__entry: "b0652bf2a7b3",
			__component: B0652bf2a7b3,
			__props: {}
		});
		$$renderer.push(`<!----> <nav data-order-nav="">`);
		if (data.prevId) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/dashboard/orders/${stringify$1(data.prevId)}`)}>← order #${escape_html(data.prevId)}</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (data.nextId) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `/dashboard/orders/${stringify$1(data.nextId)}`)}>order #${escape_html(data.nextId)} →</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <a href="/dashboard/orders">back to list</a></nav>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-CvOUrPru.js.map
