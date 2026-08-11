import { V as escape_html, _ as ensure_array_like, X as attr, $ as stringify$1, z as derived } from '../../../../../chunks/async.js-JxW4IVMW.js';
import { I as Island } from '../../../../../chunks/internal3.js-DRIflGiV.js';
import 'devalue';
import '../../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../../../chunks/paths.js-CKQC7KeW.js';
import '../../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../../chunks/utils.js-CNshUuVp.js';
import '../../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../../chunks/state.js-B_7Rd0Ds.js';
import '../../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../../chunks/payload.js-BiRFERCp.js';

//#region src/lib/FilterBar.svelte
function FilterBar($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		const statuses = [
			"all",
			"pending",
			"shipped",
			"delivered",
			"cancelled"
		];
		let current = typeof location !== "undefined" ? new URLSearchParams(location.search).get("status") || "all" : "all";
		$$renderer.push(`<div class="island" data-filterbar=""><strong>filter (island goto):</strong> <!--[-->`);
		const each_array = ensure_array_like(statuses);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let s = each_array[$$index];
			$$renderer.push(`<button${attr("data-status", s)}${attr("aria-pressed", current === s)}>${escape_html(s)}</button>`);
		}
		$$renderer.push(`<!--]--></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/.ogygia/9ae4afe01a32.svelte
function _ae4afe01a32($$renderer) {
	FilterBar($$renderer);
}
//#endregion
//#region src/lib/DataTable.svelte
function DataTable($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { rows } = $$props;
		let sortKey = "id";
		const sorted = derived(() => [...rows].sort((a, b) => {
			return a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0;
		}));
		$$renderer.push(`<div class="island" data-datatable=""><strong>client-sorted table</strong> (sort: ${escape_html(sortKey)} ${escape_html("↑")}) <table><thead><tr><th><button data-sort="id">ID</button></th><th><button data-sort="total">Total</button></th><th>Customer</th><th>Status</th></tr></thead><tbody><!--[-->`);
		const each_array = ensure_array_like(sorted());
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let o = each_array[$$index];
			$$renderer.push(`<tr${attr("data-row-id", o.id)}><td>${escape_html(o.id)}</td><td>${escape_html(o.total)}</td><td>${escape_html(o.customer)}</td><td>${escape_html(o.status)}</td></tr>`);
		}
		$$renderer.push(`<!--]--></tbody></table></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/.ogygia/832ffa0842f4.svelte
function _32ffa0842f4($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		DataTable($$renderer, { rows: data.rows });
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/orders/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		$$renderer.push(`<h1 data-static-shell="">Orders — ${escape_html(data.total)} total</h1> `);
		Island($$renderer, {
			load: true,
			__entry: "9ae4afe01a32",
			__component: _ae4afe01a32,
			__props: {}
		});
		$$renderer.push(`<!----> <p data-orders-meta="">page ${escape_html(data.page)}/${escape_html(data.pages)} · sort ${escape_html(data.sort)} ${escape_html(data.dir)} · status ${escape_html(data.status)}</p> <table data-shell-table=""><thead><tr><th>ID</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody><!--[-->`);
		const each_array = ensure_array_like(data.rows);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let o = each_array[$$index];
			$$renderer.push(`<tr><td><a${attr("href", `/dashboard/orders/${stringify$1(o.id)}`)}>#${escape_html(o.id)}</a></td><td>${escape_html(o.customer)}</td><td>${escape_html(o.status)}</td><td>${escape_html(o.total)}</td></tr>`);
		}
		$$renderer.push(`<!--]--></tbody></table> <nav data-pagination="">`);
		if (data.page > 1) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `?status=${stringify$1(data.status)}&sort=${stringify$1(data.sort)}&dir=${stringify$1(data.dir)}&page=${stringify$1(data.page - 1)}`)}>← prev</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (data.page < data.pages) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<a${attr("href", `?status=${stringify$1(data.status)}&sort=${stringify$1(data.sort)}&dir=${stringify$1(data.dir)}&page=${stringify$1(data.page + 1)}`)}>next →</a>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></nav> `);
		Island($$renderer, {
			load: true,
			__entry: "832ffa0842f4",
			__component: _32ffa0842f4,
			__props: { data }
		});
		$$renderer.push(`<!---->`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-DuJDoQMA.js.map
