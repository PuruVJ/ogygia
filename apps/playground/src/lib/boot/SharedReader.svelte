<script lang="ts">
	// An island whose only job is to read the page through a helper both worlds import
	// (`$boot/read-page`, an alias import). e2e/shared-page-module.spec.ts.
	import { onMount } from 'svelte';
	import { page_name } from '$boot/read-page';

	let name = $state('');
	onMount(() => {
		name = page_name();
	});
</script>

<p class="island" data-shared-name={name}>shared reader: {name || '(empty)'}</p>
