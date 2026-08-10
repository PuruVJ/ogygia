<script lang="ts">
	// Homepage partial demo: the server picks the component per result, signs it, and hands it back.
	// This island never imports PackageCard / EmptyResult — it renders whatever the wire delivers.
	import { Region, type RegionValue } from 'ogygia';
	import { search } from '$lib/partials/search.remote';

	let q = $state('svelte');
	let result = $state<RegionValue | null>(null);
	let loading = $state(false);

	async function run() {
		loading = true;
		try {
			result = await search(q);
		} finally {
			loading = false;
		}
	}
</script>

<div class="search-demo">
	<form
		class="search-demo-form"
		onsubmit={(e) => {
			e.preventDefault();
			run();
		}}
	>
		<input
			class="search-demo-input"
			bind:value={q}
			placeholder="try: svelte, kit, vite, ogygia"
			aria-label="Search packages"
		/>
		<button class="search-demo-btn" type="submit" disabled={loading}>
			{loading ? 'Searching…' : 'Search'}
		</button>
	</form>

	<div class="search-demo-result" aria-live="polite">
		{#if result}
			<Region of={result} />
		{:else}
			<p class="search-demo-hint">Search to fetch a component from the server.</p>
		{/if}
	</div>
</div>

<style>
	.search-demo {
		display: grid;
		gap: 1rem;
	}
	.search-demo-form {
		display: flex;
		gap: 0.5rem;
	}
	.search-demo-input {
		flex: 1;
		min-width: 0;
		padding: 0.55rem 0.8rem;
		border-radius: 8px;
		border: 1px solid var(--line-strong);
		background: none;
		color: inherit;
		font: inherit;
	}
	.search-demo-btn {
		padding: 0.55rem 1rem;
		border-radius: 8px;
		border: 1px solid currentColor;
		background: none;
		color: inherit;
		cursor: pointer;
		font: inherit;
	}
	.search-demo-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.search-demo-hint {
		margin: 0;
		opacity: 0.6;
	}
</style>
