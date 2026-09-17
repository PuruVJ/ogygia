<script lang="ts">
	// ISLANDS EDITED WHILE THEY SLEEP. This page defines the `<foreign-strip>` custom element that
	// SpacedCounter renders inside each island: its connect reaction strips every whitespace text
	// node of the island around it and leaves a stray comment — what a customer's design-system
	// runtime did to a whole header while the islands in it slept, and the shape any foreign script
	// (A/B tool, translator) produces. Svelte's hydration walk would then discard the server DOM
	// and re-render the island client-side, and the click that woke the interaction island would
	// be replayed onto a dead node. The runtime repairs the island toward the server markup it kept
	// (through the morph, so the foreign element is NOT re-created — re-inserting it would run its
	// reaction again) and hydrates that. e2e/island-foreign-edit.spec.ts.
	//
	// The definition ships as a MODULE script in this page's head — the position a design-system
	// runtime has in an app template, BEFORE Kit's head slot where an island page emits the ogygia
	// runtime. Module scripts run in document order once parsing ends, so without the handle moving
	// the runtime to the front of `<head>` the foreign tool runs first and strips every island
	// before the runtime keeps their server markup: the copy would be the edited DOM, and the heal
	// could never fire. That is exactly what a customer deploy measured.
	import Counter from '$lib/SpacedCounter.svelte' with { wake: 'interaction' };
	import VisibleCounter from '$lib/SpacedCounter.svelte' with { wake: 'visible' };

	function define_foreign_strip() {
		class ForeignStrip extends HTMLElement {
			connectedCallback() {
				const region = this.closest('ogygia-region');
				if (!region || region.hasAttribute('data-hydrated')) return;
				const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
				const doomed = [];
				for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!/\S/.test(n.textContent || '')) doomed.push(n);
				for (const n of doomed) n.parentNode && n.parentNode.removeChild(n);
				if (region.firstElementChild) region.insertBefore(document.createComment('foreign-tool'), region.firstElementChild);
				region.setAttribute('data-foreign-edited', String(Number(region.getAttribute('data-foreign-edited') || 0) + doomed.length));
				region.setAttribute('data-foreign-connects', String(Number(region.getAttribute('data-foreign-connects') || 0) + 1));
				// when the tool ran, relative to the ogygia runtime: the e2e checks it ran FIRST
				region.setAttribute('data-foreign-before-runtime', String(!customElements.get('ogygia-region')));
			}
		}
		customElements.define('foreign-strip', ForeignStrip);
	}
	const foreign_tool = `<script type="module">(${define_foreign_strip.toString()})();<\/script>`;
</script>

<svelte:head>{@html foreign_tool}</svelte:head>

<h1 data-page>islands edited while asleep</h1>
<div data-interaction-island>
	<Counter start={3} label="tap-me" />
</div>
<div style="height: 3000px" data-spacer>scroll…</div>
<div data-visible-island>
	<VisibleCounter start={7} label="scroll-me" />
</div>
