<script lang="ts">
	/**
	 * Shell's mobile chrome — ONE island (open state can't bind across island boundaries, and
	 * `site.nav()` can't run client-side, so the nav arrives as serialized data). A bottom bar with
	 * search / theme / menu over ONE sheet with two dedicated VIEWS: the search button opens it on
	 * the SEARCH view (just the inline brick — full focus, nothing else competing), the menu button
	 * on the NAV view (segmented Contents ↔ On-this-page + the footer actions). Switching while open
	 * does NOT close/reopen: the views CROSSFADE and the sheet's height glides between them (both
	 * skipped under prefers-reduced-motion). Headings are read from the rendered page's DOM (the
	 * shell has no access to the current doc's `meta.headings`, but the DOM does).
	 */
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
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
	let view = $state<'nav' | 'search'>('nav');
	let swap_el = $state<HTMLElement | undefined>();

	const reduced = () =>
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Switch views without a height JUMP: pin the swap wrapper at its current height, let the new
	 *  view render, then glide to the new height and release back to auto. Crossfade is the `{#key}`
	 *  fade pair below; both collapse to an instant swap under prefers-reduced-motion. */
	async function set_view(v: 'nav' | 'search') {
		if (view === v) return;
		const el = swap_el;
		if (!open || !el || reduced()) {
			view = v;
			return;
		}
		const h0 = el.offsetHeight;
		view = v;
		await tick();
		const target = el.lastElementChild as HTMLElement | null;
		const h1 = target?.offsetHeight ?? h0;
		el.style.height = `${h0}px`;
		// Two frames: the first commits the pinned height, the second starts the glide.
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				el.style.height = `${h1}px`;
				const done = () => {
					el.style.height = '';
					el.removeEventListener('transitionend', done);
				};
				el.addEventListener('transitionend', done);
			})
		);
	}

	function openMenu() {
		if (open) void set_view('nav');
		else {
			view = 'nav';
			open = true;
		}
	}
	function openSearch() {
		if (open) void set_view('search');
		else {
			view = 'search';
			open = true;
		}
	}
</script>

<BottomBar>
	{#snippet lead()}
		<a class="og-cbar-brand" href={base || '/'}>{brand}</a>
	{/snippet}
	{#snippet actions()}
		<button type="button" class="og-cbar-btn" data-ph-sheet-toggle aria-label={open && view === 'search' ? 'Close search' : 'Search'} aria-expanded={open && view === 'search'} onclick={() => (open && view === 'search' ? (open = false) : openSearch())}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
		</button>
		<ThemeToggle />
		<button type="button" class="og-cbar-btn og-cbar-menu" data-ph-sheet-toggle aria-label={open && view === 'nav' ? 'Close menu' : 'Open menu'} aria-expanded={open && view === 'nav'} onclick={() => (open && view === 'nav' ? (open = false) : openMenu())}>
			<span class="og-cbar-bars" class:og-open={open && view === 'nav'}><span></span><span></span><span></span></span>
		</button>
	{/snippet}
</BottomBar>

<!-- ONE sheet, two views. Switching views crossfades the content while the wrapper's height glides
     (see set_view) — never a close/reopen, never a height jump. -->
<Sheet bind:open label={view === 'search' ? 'Search' : 'Navigation'}>
	<div class="og-sheet-swap" bind:this={swap_el}>
		{#key view}
			<div class="og-sheet-view" in:fade={{ duration: reduced() ? 0 : 160 }} out:fade={{ duration: reduced() ? 0 : 110 }}>
				{#if view === 'search'}
					<!-- The dedicated SEARCH view: just the inline brick — the input gets the surface. -->
					<div class="og-sheet-scroll">
						<div class="og-cbar-search"><Search {base} mode="inline" placeholder="Search…" /></div>
					</div>
				{:else}
					<!-- The NAV view is just the contents tree — the page outline lives IN the page
					     (Doc's mobile inline "On this page"), not buried in the nav sheet. -->
					<div class="og-sheet-scroll">
						<Sidebar {nav} {base} />
					</div>
				{/if}
			</div>
		{/key}
	</div>

	{#snippet footer()}
		{#if view === 'nav' && actions}<div class="og-cbar-actions">{@render actions()}</div>{/if}
	{/snippet}
</Sheet>

<svelte:window onhashchange={() => (open = false)} />
