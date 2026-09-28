<script lang="ts">
	// The browser half of the design-system layer: Stencil fires `appload` on window once every
	// component on the page has hydrated. Mark it, from navigation start, so the report shows how
	// long the CDN behaviour layer took the visitor — next to the islands' own hydration times.
	import { onMount } from 'svelte';
	import { mark } from 'ogygia/profiler/client';
	onMount(() => {
		// already done before this island woke (a warm cache): the time from navigation start to now
		// is the upper bound, marked as such
		if (document.querySelector('.hydrated')) {
			mark.start('ds.hydrate', { late: true }, { from: 'navigation' }).end();
			return;
		}
		void mark.event('ds.hydrate', 'appload', window, { from: 'navigation' });
	});
</script>

<span hidden data-ds-mark></span>
