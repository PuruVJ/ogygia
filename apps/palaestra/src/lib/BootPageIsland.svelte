<script lang="ts">
	// A SEPARATE page island living inside the layout island's adopted slot. Tests three things at once:
	// (1) the slot survived, (2) this nested island still WAKES (click increments), (3) it reads the
	// layout's context across the split, and whether it sees the SAME shared bootStore instance.
	import { getContext } from 'svelte';
	import { bootStore } from '$lib/boot-store.svelte.js';

	let n = $state(0);
	const dir = getContext<string>('currentDir');
</script>

<button
	data-page-island
	data-page-dir={dir ?? '(none)'}
	data-page-sees-boot={bootStore.ready}
	onclick={() => n++}
>page island {n} · dir={dir ?? '(none)'} · sawBoot={bootStore.ready}</button>
