<script lang="ts">
	/**
	 * The nav tree, rendered. A pure function of `NavTree`: groups nest recursively, leaves link,
	 * plain links pass through. Inside `<Shell>` it reads the site from context; standalone it takes
	 * `{site}` (or a precomputed `{nav}` — the wrap pattern: transform the data, hand it back).
	 * Customize per-item with the `item` snippet; everything else is CSS via `.ph-*` hooks.
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { get_shell_context } from '../context.js';
	import { roving } from './roving.js';
	import type { Site } from '../pharos.js';
	import type { NavLeaf, NavTree } from '../types.js';

	let {
		site,
		base,
		nav,
		item
	}: {
		site?: Site;
		base?: string;
		nav?: NavTree;
		/** Draw one leaf yourself: `{#snippet item(leaf, active)}…{/snippet}`. */
		item?: Snippet<[NavLeaf, boolean]>;
	} = $props();

	const ctx = get_shell_context();
	// Init-time snapshot ONLY for the standalone fetch path (no `nav` prop) — that fetch runs once in
	// this csr=false SSR pass.
	// svelte-ignore state_referenced_locally
	const the_site = site ?? ctx?.site;
	// svelte-ignore state_referenced_locally
	const the_base = base ?? ctx?.base ?? '';
	// svelte-ignore state_referenced_locally
	const fetched: NavTree = nav ? [] : the_site ? await the_site.nav({ base: the_base }) : [];
	// The tree is REACTIVE to the `nav` prop: this island is commonly KEPT (`keep: 'ph-sidebar'`), and
	// on every SPA navigation the router pushes the incoming page's props into the persisted app
	// (`absorbPersistProps` → LiveHost.setProps). A version/locale switch therefore swaps the tree IN
	// PLACE — new links, new base prefixes — without a re-mount, so the active chip still glides.
	const tree: NavTree = $derived(nav ?? fetched);

	const path = $derived(page.url.pathname);

	/**
	 * A stable, unique `view-transition-name` for one nav row. The page cross-fade is a View Transition,
	 * so the LIVE sidebar DOM is hidden behind the VT snapshot mid-nav — a JS/CSS slide of the marker
	 * wouldn't be visible. Instead the highlight box (a chip carrying `view-transition-name: ph-nav-active`)
	 * lives behind the ACTIVE row; when the active class moves to the new leaf, the VT captures the chip at
	 * the new row and slides it there for us. But a named element paints ABOVE the page snapshot, so a
	 * bare chip would cover the labels it passes. Fix: give every row its OWN VT layer (a unique name here,
	 * a shared `view-transition-class` in CSS) and force the chip BENEATH them by z-index — so each label
	 * stays put in its own layer and the chip glides underneath. Names must be unique per document; the
	 * key (href/label) is, so we sanitise it to a valid custom-ident and prefix by row kind.
	 */
	function vt_name(prefix: string, key: string): string {
		return `${prefix}-${key.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
	}
</script>

{#snippet items(list: NavTree)}
	<ul class="ph-nav-list">
		{#each list as node (node.kind === 'link' ? `L${node.href}` : node.kind === 'group' ? `G${node.label}` : node.slug)}
			{#if node.kind === 'group'}
				<li class="ph-nav-group">
					<span class="ph-nav-label" style="view-transition-name: {vt_name('phg', node.label)}">{node.label}{#if node.badge}<span class="ph-badge">{node.badge}</span>{/if}</span>
					{@render items(node.items)}
				</li>
			{:else if node.kind === 'link'}
				<li><a class="ph-nav-link ph-nav-external" style="view-transition-name: {vt_name('phx', node.href)}" href={node.href}>{node.label}</a></li>
			{:else if item}
				<li>{@render item(node, path === node.href)}</li>
			{:else}
				<li>
					<a class="ph-nav-link" class:ph-active={path === node.href} aria-current={path === node.href ? 'page' : undefined} href={node.href} style="view-transition-name: {vt_name('phl', node.href)}">
						<!-- The gliding highlight box: only the ACTIVE row carries it, and it holds
						     `view-transition-name: ph-nav-active` (in CSS), so the page cross-fade's View
						     Transition slides it from the old active row to the new one. It sits BEHIND the
						     label text and beneath every row's own VT layer (z-index), so it never clips a label. -->
						{#if path === node.href}<span class="ph-nav-chip" aria-hidden="true"></span>{/if}
						{node.title}{#if node.badge}<span class="ph-badge">{node.badge}</span>{/if}
					</a>
				</li>
			{/if}
		{/each}
	</ul>
{/snippet}

<!-- Roving tabindex: the sidebar is ONE tab stop; Up/Down move between links (entry lands on the
     active page's link). Focus-only — Enter/click navigate natively. -->
<nav class="ph-sidebar" aria-label="Documentation" {@attach roving({ selector: '.ph-nav-link', orientation: 'vertical' })}>
	{@render items(tree)}
</nav>
