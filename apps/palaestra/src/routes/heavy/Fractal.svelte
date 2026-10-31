<script lang="ts">
	import Self from './Fractal.svelte';

	// A recursive component: branches `fanout` ways until `depth` hits 0, so node count grows
	// exponentially (fanout^depth). Deep, wide call stacks — the profiler's flame graph shows
	// `Fractal` calling `Fractal` many levels down, and the component's total time balloons.
	let {
		depth = 6,
		fanout = 3,
		path = '0'
	}: { depth?: number; fanout?: number; path?: string } = $props();

	// a little per-node string work so leaves aren't free (it renders once, on the server, so the
	// one-time reads of the props are the point)
	// svelte-ignore state_referenced_locally
	const hue = (path.length * 47) % 360;
	// svelte-ignore state_referenced_locally
	const kids = depth > 0 ? Array.from({ length: fanout }, (_, i) => i) : [];
</script>

<div class="fr" style="--h:{hue}">
	<span class="fr-k">{path}</span>
	{#each kids as i (i)}
		<Self depth={depth - 1} {fanout} path={`${path}.${i}`} />
	{/each}
</div>

<style>
	.fr {
		border-left: 2px solid hsl(var(--h) 60% 60%);
		margin-left: 6px;
		padding-left: 4px;
	}
	.fr-k {
		font-size: 0.6rem;
		color: #a0aec0;
	}
</style>
