<script lang="ts">
	// Wire-law harness island. Each button fires one shape's remote; each result area is probed by
	// the measurement script (presence, computed styles, hydration, endpoint fetch counts).
	import { Region } from 'ogygia';
	import { arrayShape, objectShape, propsEager, propsLazy, recomposerShape, treeShape } from '$lib/shapes.remote';

	let go = $state({ array: false, object: false, pe: false, pl: false, rc: false, tree: false });
	let err = $state<Record<string, string>>({});

	function arm(k: keyof typeof go) {
		go[k] = true;
	}
	/** Wrap a shape promise so a serialization failure surfaces in the DOM instead of vanishing. */
	function watch<T>(k: string, p: Promise<T>): Promise<T> {
		p.catch((e) => (err[k] = e instanceof Error ? e.message : String(e)));
		return p;
	}
</script>

<section data-shape="array">
	<h2>array of regions</h2>
	<button onclick={() => arm('array')}>run array</button>
	{#if go.array}
		{#await watch('array', arrayShape()) then list}
			{#each list as r, i (i)}<Region of={r} />{/each}
		{/await}
	{/if}
	{#if err.array}<pre class="err">{err.array}</pre>{/if}
</section>

<section data-shape="object">
	<h2>object of regions</h2>
	<button onclick={() => arm('object')}>run object</button>
	{#if go.object}
		{#await watch('object', objectShape()) then slots}
			<Region of={slots.header} />
			<Region of={slots.main} />
			<Region of={slots.rail} />
		{/await}
	{/if}
	{#if err.object}<pre class="err">{err.object}</pre>{/if}
</section>

<section data-shape="props-eager">
	<h2>region in props (awaited outer)</h2>
	<button onclick={() => arm('pe')}>run props eager</button>
	{#if go.pe}
		<Region of={watch('pe', propsEager())}>
			{#snippet placeholder()}<p class="ph">loading…</p>{/snippet}
		</Region>
	{/if}
	{#if err.pe}<pre class="err">{err.pe}</pre>{/if}
</section>

<section data-shape="props-lazy">
	<h2>region in props (lazy outer)</h2>
	<button onclick={() => arm('pl')}>run props lazy</button>
	{#if go.pl}
		<Region of={watch('pl', propsLazy())}>
			{#snippet placeholder()}<p class="ph">loading…</p>{/snippet}
		</Region>
	{/if}
	{#if err.pl}<pre class="err">{err.pl}</pre>{/if}
</section>

<section data-shape="tree">
	<h2>nested tree (the blocks shape)</h2>
	<button onclick={() => arm('tree')}>run tree</button>
	{#if go.tree}
		<Region of={watch('tree', treeShape())}>
			{#snippet placeholder()}<p class="ph">loading…</p>{/snippet}
		</Region>
	{/if}
	{#if err.tree}<pre class="err">{err.tree}</pre>{/if}
</section>

<section data-shape="recomposer">
	<h2>marked recomposer</h2>
	<button onclick={() => arm('rc')}>run recomposer</button>
	{#if go.rc}
		<Region of={watch('rc', recomposerShape())}>
			{#snippet placeholder()}<p class="ph">loading…</p>{/snippet}
		</Region>
	{/if}
	{#if err.rc}<pre class="err">{err.rc}</pre>{/if}
</section>

<style>
	section {
		border-block-end: 1px solid #ccc3;
		padding: 0.8rem 0;
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.err {
		color: #c33;
		white-space: pre-wrap;
		max-width: 60ch;
	}
	.ph {
		opacity: 0.6;
	}
</style>
