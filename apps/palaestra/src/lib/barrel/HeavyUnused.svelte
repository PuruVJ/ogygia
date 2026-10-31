<script lang="ts">
	// A component that lives IN the barrel but is never islanded/used on the test page. It carries a
	// unique marker string. If barrel tree-shaking works, this marker must NOT appear in any island
	// chunk — the Ticker/Flag islands import ONLY their own component through the barrel.
	export const HEAVY_UNUSED_COMPONENT_MARKER = 'ogygia_barrel_heavy_component_canary_88913';
	let { rows = 3 }: { rows?: number } = $props();
</script>

<div class="island" data-heavy>
	<p>{HEAVY_UNUSED_COMPONENT_MARKER}</p>
	{#each Array.from({ length: rows }) as _, i}
		<div>heavy row {i}</div>
	{/each}
</div>
