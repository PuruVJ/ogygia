import { V as escape_html } from '../../chunks/async.js-JxW4IVMW.js';
import { p as page } from '../../chunks/state.js-B_7Rd0Ds.js';
import 'devalue';
import '../../chunks/internal.js-gg_mc6sK.js';
import '../../chunks/shared.js-B5OSxjL7.js';
import '../../chunks/routing.js-poy0Ceuj.js';
import '../../chunks/exports.js-DUO0Cq7p.js';
import '../../chunks/utils.js-CNshUuVp.js';

//#region ../node_modules/.pnpm/@sveltejs+kit@2.70.2_@sveltejs+vite-plugin-svelte@7.2.0_svelte@5.56.8_vite@8.2.0_@types_b82a031257a225430218912b412880c1/node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte
function Error($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<h1>${escape_html(page.status)}</h1> <p>${escape_html(page.error?.message)}</p>`);
	});
}

export { Error as default };
//# sourceMappingURL=error.svelte.js-B_ExGqTF.js.map
