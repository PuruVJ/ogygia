// A host island lifts its own lakes out around its hydrate and puts them back. A lake inside a LIVE
// snippet the island renders is not its own: the snippet hydrates after it (its entry imports) and
// adopts that lake element as it stands. Lifting it anyway moved its trailing anchors in front of its
// content and the snippet's hydrate then mismatched. It stays in place — settled and remembered all the
// same — while a lake inside a FROZEN snippet (adopted HTML nothing hydrates) is the host's as before.
import { expect, test } from 'vitest';
import { lift, restore } from '../../src/runtime/lakes.ts';
import { runtime_session } from '../../src/runtime/session.ts';

test('a live snippet’s lake is left in place by its host’s lift and settled by its restore', () => {
	document.body.innerHTML =
		'<ogygia-region wake="load" data-host>' +
		'<ogygia-region wake="none" entry="own"><p data-own>own</p><!----></ogygia-region>' +
		'<ogygia-snippet style="display:contents"><ogygia-region wake="none" entry="live"><p data-live>live</p><!----></ogygia-region></ogygia-snippet>' +
		'<ogygia-snippet data-og-static style="display:contents"><ogygia-region wake="none" entry="frozen"><p data-frozen>frozen</p></ogygia-region></ogygia-snippet>' +
		'</ogygia-region>';
	const host = document.querySelector('[data-host]')!;
	const live_lake = document.querySelector('[entry="live"]')!;
	const live_html = live_lake.innerHTML;

	const lifted = lift(host);
	expect(lifted.map((l) => l.id)).toEqual(['own', 'frozen']);
	expect(document.querySelector('[data-own]')).toBeNull();
	expect(document.querySelector('[data-frozen]')).toBeNull();
	expect(live_lake.innerHTML).toBe(live_html); // untouched: nodes, anchors and order

	restore(host, lifted);
	expect(document.querySelector('[entry="own"] [data-own]')).not.toBeNull();
	expect(document.querySelector('[entry="frozen"] [data-frozen]')).not.toBeNull();
	expect(live_lake.innerHTML).toBe(live_html);
	expect(runtime_session.settled_lakes.has(live_lake)).toBe(true);
	expect(runtime_session.initialized_lakes.has('live')).toBe(true);
});
