import { V as escape_html } from '../../../../chunks/async.js-JxW4IVMW.js';
import { p as page } from '../../../../chunks/state.js-B_7Rd0Ds.js';
import 'devalue';
import '../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../chunks/utils.js-CNshUuVp.js';

//#region src/routes/(spa)/dashboard/+error.svelte
function _error($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<h1 data-error-page="">Error ${escape_html(page.status)}</h1> <p data-error-message="">${escape_html(page.error?.message)}</p> <a href="/dashboard/orders">← back to orders</a>`);
	});
}

export { _error as default };
//# sourceMappingURL=_error.svelte.js-j9I5htPi.js.map
