<script lang="ts">
	import { SearchPage } from 'ogygia/pharos';

	// Server-computed results (same brain, csr=false, zero client JS) — the ⌘K palette's fallback.
	let { data } = $props();
</script>

<div class="search-page">
	<SearchPage q={data.q} hits={data.hits} title="Search the docs" />
</div>

<style>
	.search-page {
		max-width: var(--sk-page-content-width);
		margin: 0 auto;
		padding: var(--sk-page-padding-top) var(--sk-page-padding-side) var(--sk-page-padding-bottom);
	}
</style>
