<script lang="ts">
	/**
	 * Calypso's mobile chrome — ONE island (open state can't bind across island boundaries, and
	 * `site.nav()` can't run client-side, so the nav arrives as serialized data). A bottom bar with
	 * search / theme / menu, opening a `Sheet` that holds: the search brick, a segmented
	 * Contents ↔ On-this-page toggle. Headings are read from the rendered page's DOM (the shell has no
	 * access to the current doc's `meta.headings`, but the DOM does).
	 */
	import BottomBar from './BottomBar.svelte';
	import Sheet from './Sheet.svelte';
	import Sidebar from './Sidebar.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import Search from './Search.svelte';
	import type { NavTree } from '../types.js';

	let {
		nav,
		base = '',
		brand = 'Docs',
		actions
	}: {
		nav: NavTree;
		base?: string;
		brand?: string;
		/** Header tools (a PORTABLE snippet) — cross the island boundary and come alive in the footer. */
		actions?: import('svelte').Snippet;
	} = $props();

	let open = $state(false);
	let seg = $state<'contents' | 'toc'>('contents');
	let toc = $state<{ id: string; text: string; depth: number }[]>([]);

	function collectHeadings() {
		const nodes = document.querySelectorAll<HTMLElement>('.ph-body :is(h2, h3, h4)[id]');
		toc = Array.from(nodes).map((h) => ({ id: h.id, text: h.textContent ?? '', depth: Number(h.tagName[1]) }));
	}

	function openMenu() {
		seg = 'contents';
		open = true;
	}
	function showToc() {
		seg = 'toc';
		collectHeadings();
	}
</script>

<BottomBar>
	{#snippet lead()}
		<a class="ph-cbar-brand" href={base || '/'}>{brand}</a>
	{/snippet}
	{#snippet actions()}
		<button type="button" class="ph-cbar-btn" aria-label="Search" onclick={openMenu}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		</button>
		<ThemeToggle />
		<button type="button" class="ph-cbar-btn ph-cbar-menu" data-ph-sheet-toggle aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onclick={() => (open ? (open = false) : openMenu())}>
			<span class="ph-cbar-bars" class:ph-open={open}><span></span><span></span><span></span></span>
		</button>
	{/snippet}
</BottomBar>

<Sheet bind:open label="Navigation">
	<div class="ph-cbar-search"><Search {base} mode="inline" placeholder="Search…" /></div>

	<div class="ph-seg" role="tablist">
		<button type="button" role="tab" class="ph-seg-btn" class:ph-active={seg === 'contents'} aria-selected={seg === 'contents'} onclick={() => (seg = 'contents')}>Contents</button>
		<button type="button" role="tab" class="ph-seg-btn" class:ph-active={seg === 'toc'} aria-selected={seg === 'toc'} onclick={showToc}>On this page</button>
	</div>

	{#if seg === 'contents'}
		<Sidebar {nav} {base} />
	{:else if toc.length}
		<nav class="ph-toc" aria-label="On this page">
			<ul class="ph-toc-list">
				{#each toc as h (h.id)}
					<li class={`ph-toc-item ph-toc-d${h.depth}`}><a class="ph-toc-link" href={`#${h.id}`} onclick={() => (open = false)}>{h.text}</a></li>
				{/each}
			</ul>
		</nav>
	{:else}
		<p class="ph-cbar-empty">No headings on this page.</p>
	{/if}

	{#snippet footer()}
		{#if actions}<div class="ph-cbar-actions">{@render actions()}</div>{/if}
	{/snippet}
</Sheet>

<svelte:window onhashchange={() => (open = false)} />
