<script lang="ts">
	/**
	 * `SearchPage` — the no-JS search fallback UI, a pharos primitive. A plain GET form + a server-
	 * rendered results list; zero client JS required. Mount it at `/search`:
	 *
	 * ```ts
	 * // routes/search/+page.server.ts
	 * export const prerender = false;
	 * export const load = async ({ url }) => {
	 *   const q = (url.searchParams.get('q') ?? '').trim();
	 *   return { q, hits: q ? await site.search(q) : [] };
	 * };
	 * ```
	 * ```svelte
	 * <!-- routes/search/+page.svelte -->
	 * <SearchPage q={data.q} hits={data.hits} />
	 * ```
	 *
	 * The `<Search>` trigger links here, so the ⌘K palette is a pure enhancement over this page.
	 */
	import type { SearchHit } from '../search.js';

	let {
		q = '',
		hits = [],
		title = 'Search',
		placeholder = 'Search the docs…',
		action
	}: {
		q?: string;
		hits?: SearchHit[];
		title?: string;
		placeholder?: string;
		/** Form GET target. Default: submit to the current URL (`/search?q=…`). */
		action?: string;
	} = $props();
</script>

<div class="ph-article ph-searchpage">
	<h1 class="ph-title">{title}</h1>

	<form class="ph-search-field ph-searchpage-field" role="search" method="get" {action}>
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="ph-search-scene-input"
			type="search"
			name="q"
			value={q}
			{placeholder}
			aria-label={placeholder}
			autocomplete="off"
			autofocus
		/>
		<button class="ph-searchpage-go" type="submit">Search</button>
	</form>

	{#if q}
		<p class="ph-searchpage-count">
			{hits.length} result{hits.length === 1 ? '' : 's'} for “{q}”
		</p>
		{#if hits.length}
			<ul class="ph-search-results ph-searchpage-results">
				{#each hits as hit (hit.href)}
					<li>
						<a class="ph-search-hit" href={hit.href}>
							<span class="ph-search-hit-title"
								>{hit.title}{#if hit.heading}<span class="ph-search-hit-heading"> › {hit.heading}</span
									>{/if}</span
							>
							{#if hit.excerpt}<span class="ph-search-hit-excerpt">{@html hit.excerpt}</span>{/if}
							<span class="ph-search-hit-section">{hit.section}</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="ph-search-empty ph-searchpage-empty">No results for “{q}”.</p>
		{/if}
	{/if}
</div>
