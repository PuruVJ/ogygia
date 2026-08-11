import { V as escape_html } from './async.js-JxW4IVMW.js';

//#region src/lib/Counter.svelte
function Counter($$renderer, $$props) {
	let { start = 0, label = "Counter" } = $$props;
	let count = start;
	$$renderer.push(`<div class="island" data-counter=""><strong>${escape_html(label)}</strong>: <button>count is ${escape_html(count)}</button></div>`);
}

export { Counter as C };
//# sourceMappingURL=Counter.js-BNzt6BII.js.map
