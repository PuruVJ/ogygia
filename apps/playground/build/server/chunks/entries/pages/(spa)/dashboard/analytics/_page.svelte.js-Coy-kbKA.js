import { V as escape_html, _ as ensure_array_like, X as attr, z as derived } from '../../../../../chunks/async.js-JxW4IVMW.js';
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

//#region src/lib/BarChart.svelte
function BarChart($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { counts } = $$props;
		const entries = derived(() => [...counts.entries()]);
		const max = derived(() => Math.max(...entries().map(([, v]) => v), 1));
		$$renderer.push(`<div class="island" data-barchart=""><strong>orders by status</strong> <svg width="360" height="170" role="img" aria-label="orders by status"><!--[-->`);
		const each_array = ensure_array_like(entries());
		for (let i = 0, $$length = each_array.length; i < $$length; i++) {
			let [label, v] = each_array[i];
			$$renderer.push(`<rect${attr("x", i * 70 + 10)}${attr("y", 150 - v / max() * 130)} width="50"${attr("height", v / max() * 130)} fill="#4f46e5"></rect><text${attr("x", i * 70 + 35)} y="150" dy="12" font-size="9" text-anchor="middle">${escape_html(label)}</text><text${attr("x", i * 70 + 35)}${attr("y", 150 - v / max() * 130 - 4)} font-size="9" text-anchor="middle">${escape_html(v)}</text>`);
		}
		$$renderer.push(`<!--]--></svg></div>`);
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/analytics/.ogygia/5230140ffafb.svelte
function _230140ffafb($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		BarChart($$renderer, { counts: data.stats.byStatus });
	});
}
//#endregion
//#region src/routes/(spa)/dashboard/analytics/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data } = $$props;
		$$renderer.push(`<h1 data-static-shell="">Analytics</h1> <p data-static-shell="">Revenue: ${escape_html(data.stats.revenue)} · orders: ${escape_html(data.stats.count)} · generated ${escape_html(data.stats.generatedAt.toISOString())}</p> <div class="spacer">scroll down to hydrate the chart island (visible strategy)…</div> `);
		Island($$renderer, {
			visible: "200px",
			__entry: "5230140ffafb",
			__component: _230140ffafb,
			__props: { data }
		});
		$$renderer.push(`<!---->`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-Coy-kbKA.js.map
