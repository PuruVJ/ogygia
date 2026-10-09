<script lang="ts">
	/**
	 * COMPARE two reports (`/compare/[a]/[b]`). The server's comparison when it holds both reports
	 * (static render, CompareBody); otherwise the LocalCompare island builds the same comparison
	 * from this browser's store — a restarted server or an ephemeral host forgets, the browser does
	 * not.
	 */
	import Shell from './Shell.svelte';
	import CompareBody from './CompareBody.svelte';
	import LocalCompare from './LocalCompare.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';

	let { data }: ProfilerRoutes['/compare/[a]/[b]'] = $props();
	const { base, cmp, a, b } = $derived(data);
</script>

<svelte:head><title>compare — {cmp ? `${cmp.a.label} vs ${cmp.b.label}` : `${a} vs ${b}`}</title></svelte:head>

<Shell {base}>
	{#if cmp}
		<CompareBody {base} {cmp} />
	{:else}
		<LocalCompare {base} {a} {b} />
	{/if}
</Shell>
