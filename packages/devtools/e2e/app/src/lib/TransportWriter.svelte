<script lang="ts">
	// Island A: receives the transportable instance as a PROP and mutates it.
	import { SharedCounter } from './counter-object.svelte.ts';
	import { AliasProbe } from './alias-probe.svelte.ts';

	let { counter, probe }: { counter: SharedCounter; probe?: AliasProbe } = $props();
</script>

<div class="island" data-transport-writer data-is-instance={counter instanceof SharedCounter}>
	<strong>{counter.label}</strong>
	<button onclick={() => counter.inc()}>inc (count is {counter.count})</button>
	{#if probe}<span data-alias-probe>{probe.v}</span>{/if}
</div>
