<script lang="ts">
	// Homepage partial demo: the server picks the component per result, signs it, and hands it back.
	// This island never imports PackageCard / EmptyResult — it renders whatever the wire delivers.
	//
	// ONE loading indicator: `of` takes the remote call's promise, so the region owns the whole
	// wait (fetch AND styled paint) and `placeholder` fills it. No `loading` state to reconcile —
	// there is nothing here that claims to know when the card is ready, so nothing can disagree.
	import { Region } from 'ogygia';
	import { search } from '$lib/partials/search.remote';

	let q = $state('svelte');
	let query = $state<string | null>(null);
</script>

<div class="search-demo">
	<form
		class="search-demo-form"
		onsubmit={(e) => {
			e.preventDefault();
			query = q;
		}}
	>
		<input
			class="search-demo-input"
			bind:value={q}
			placeholder="try: svelte, kit, vite, ogygia"
			aria-label="Search packages"
		/>
		<button class="search-demo-btn" type="submit">Search</button>
	</form>

	<div class="search-demo-result" aria-live="polite">
		{#if query}
			<Region of={search(query)}>
				{#snippet placeholder()}<p class="search-demo-hint">Searching…</p>{/snippet}
			</Region>
		{:else}
			<p class="search-demo-hint">Search to fetch a component from the server.</p>
		{/if}
	</div>
</div>

<style>
	.search-demo {
		display: grid;
		gap: 0.75rem;
	}
	.search-demo-form {
		display: flex;
		gap: 0.5rem;
	}
	.search-demo-input {
		flex: 1;
		font: inherit;
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		border-radius: 8px;
		background: transparent;
		color: inherit;
	}
	.search-demo-btn {
		font: inherit;
		padding: 0.45rem 0.9rem;
		border: 1px solid currentColor;
		border-radius: 8px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.search-demo-hint {
		margin: 0;
		opacity: 0.6;
	}
</style>
