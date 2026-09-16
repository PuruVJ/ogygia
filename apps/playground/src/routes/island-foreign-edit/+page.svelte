<script lang="ts">
	// ISLANDS EDITED WHILE THEY SLEEP. The inline script below does, after load, what a customer's
	// design-system runtime did to a whole header: it strips every whitespace text node inside each
	// sleeping island and leaves a stray comment — the shape any foreign script (A/B tool,
	// translator) produces. Svelte's hydration walk would then discard the server DOM and re-render
	// the island client-side, and the click that woke the interaction island would be replayed onto
	// a dead node. The runtime hydrates against the server markup it kept instead.
	// e2e/island-foreign-edit.spec.ts.
	import { script } from 'ogygia';
	import Counter from '$lib/SpacedCounter.svelte' with { wake: 'interaction' };
	import VisibleCounter from '$lib/SpacedCounter.svelte' with { wake: 'visible' };

	function edit_sleeping_islands() {
		const run = () => {
			for (const region of document.querySelectorAll('ogygia-region:not([data-hydrated]):not([wake="none"])')) {
				const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
				const doomed = [];
				for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!/\S/.test(n.textContent || '')) doomed.push(n);
				for (const n of doomed) n.parentNode && n.parentNode.removeChild(n);
				if (region.firstElementChild) region.insertBefore(document.createComment('foreign-tool'), region.firstElementChild);
				region.setAttribute('data-foreign-edited', String(doomed.length));
			}
		};
		if (document.readyState === 'complete') run();
		else window.addEventListener('load', run, { once: true });
	}
</script>

<svelte:head>{@html script(edit_sleeping_islands)}</svelte:head>

<h1 data-page>islands edited while asleep</h1>
<div data-interaction-island>
	<Counter start={3} label="tap-me" />
</div>
<div style="height: 3000px" data-spacer>scroll…</div>
<div data-visible-island>
	<VisibleCounter start={7} label="scroll-me" />
</div>
