import { V as escape_html } from '../../../../chunks/async.js-JxW4IVMW.js';
import { p as page } from '../../../../chunks/state.js-B_7Rd0Ds.js';
import 'devalue';
import '../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../chunks/utils.js-CNshUuVp.js';

//#region src/routes/(spa)/dashboard/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { children, data } = $$props;
		$$renderer.push(`<div style="display:flex; gap:2rem;"><aside style="min-width:180px;"><h3 data-static-shell="">Dashboard</h3> <p data-static-shell="">User: ${escape_html(data.user.name)} (${escape_html(data.user.role)})</p> <nav style="display:flex; flex-direction:column; gap:.25rem;"><a href="/dashboard/orders">Orders (${escape_html(data.navCounts.get("pending"))} pending)</a> <a href="/dashboard/orders?status=shipped&amp;sort=total&amp;dir=desc">Shipped (by total)</a> <a href="/dashboard/analytics">Analytics</a> <a href="/dashboard/settings">Settings</a> <a href="/">← Site home</a></nav></aside> <main style="flex:1;"><div data-breadcrumb="" style="color:#888; font-size:.9rem;">route: ${escape_html(page.route.id)} — path: ${escape_html(page.url.pathname)}</div> `);
		children($$renderer);
		$$renderer.push(`<!----></main></div>`);
	});
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte.js-CFfwGffR.js.map
