<script lang="ts">
	// Stamps which build's code woke it: the cache check reads `data-ran` off the page.
	import { VERSION } from './version.js';
	let { label }: { label: string } = $props();
	let ran = $state('');
	$effect(() => {
		ran = VERSION;
	});
</script>

<p data-probe={label} data-ran={ran || undefined}>{label}: {ran || 'asleep'}</p>
