<script lang="ts">
	// REGRESSION FIXTURE — the bcms all-products crash (see e2e/split-brain.ts).
	// A shared component (island graph member, ALSO rendered by the csr=true /kit page) reads
	// `$page.data` in onMount and calls a method on the value — exactly what a real app does
	// (`$page.data._locale.toLowerCase()`). The island-world shim starts with `data: {}`; on a
	// Kit-booted page nothing seeded it, so the read returned undefined, the method call threw
	// INSIDE Kit's synchronous hydrate flush, and ALL page JS died (headers never mounted).
	// The kit-page bridge must hand this component Kit's REAL page data instead.
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	let mounted_word = 'unmounted';
	onMount(() => {
		// The crash line: method call on a data field, no guard — like the app code that broke.
		mounted_word = ($page.data.sharedWord as string).toLowerCase();
	});
</script>

<span data-shared-data>{mounted_word}</span>
