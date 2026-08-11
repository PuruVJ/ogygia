import { V as escape_html } from './async.js-JxW4IVMW.js';
import { p as personalGreeting } from './server-greeting.remote.js-CHHDI49u.js';

//#region src/lib/Greeting.svelte
function Greeting($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { salutation = "Hi" } = $$props;
		var data;
		var $$promises = $$renderer.run([async () => data = await personalGreeting()]);
		$$renderer.push(`<div class="greeting svelte-1o6wnyg" data-server-greeting=""><strong>${escape_html(salutation)}, `);
		$$renderer.async([$$promises[0]], ($$renderer) => $$renderer.push(() => escape_html(data.name)));
		$$renderer.push(`!</strong> <span class="ts svelte-1o6wnyg" data-server-at="">rendered on the server at `);
		$$renderer.async([$$promises[0]], ($$renderer) => $$renderer.push(() => escape_html(data.at)));
		$$renderer.push(`</span></div>`);
	});
}

export { Greeting as G };
//# sourceMappingURL=Greeting.js-FtuFdQmi.js.map
