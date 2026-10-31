<script lang="ts">
	// An island that reaches `greetings.remote` only through a DYNAMIC import (a chunk that downloads
	// after a click). The remote is still this island's call → the build lists it → the seed ships.
	import type { Component } from 'svelte';
	let Callee = $state<Component<{ name: string }> | null>(null);
</script>

<div class="island" data-lazy-caller>
	<button data-lazy-btn onclick={async () => (Callee = (await import('./LazyCallee.svelte')).default)}>load the caller</button>
	{#if Callee}
		<Callee name="lazy" />
	{/if}
</div>
