<script lang="ts">
	/**
	 * The nav tree, rendered. A pure function of `NavTree`: groups nest recursively, leaves link,
	 * plain links pass through. Inside `<Shell>` it reads the site from context; standalone it takes
	 * `{site}` (or a precomputed `{nav}` — the wrap pattern: transform the data, hand it back).
	 * Customize per-item with the `item` snippet; everything else is CSS via `.og-*` hooks.
	 */
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { get_shell_context } from '../context.js';
	import { roving } from './roving.js';
	import type { Site } from '../site.js';
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
	// The tree is REACTIVE to the `nav` prop: this island is commonly KEPT (`keep: 'og-sidebar'`), and
	// on every SPA navigation the router pushes the incoming page's props into the persisted app
	// (`absorbPersistProps` → LiveHost.setProps). A version/locale switch therefore swaps the tree IN
	// PLACE — new links, new base prefixes — without a re-mount, so the active chip still glides.
	const tree: NavTree = $derived(nav ?? fetched);

	const path = $derived(page.url.pathname);

	/**
	 * A stable, unique `view-transition-name` for one nav row. The page cross-fade is a View Transition,
	 * so the LIVE sidebar DOM is hidden behind the VT snapshot mid-nav — a JS/CSS slide of the marker
	 * wouldn't be visible. Instead the highlight box (a chip carrying `view-transition-name: og-nav-active`)
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

	/**
	 * SCROLL CONTINUITY + active-in-view. This island is KEPT, so its DOM rides the body swap — but
	 * the element that actually SCROLLS is usually the surrounding panel (skin-owned, outside the
	 * kept node), which is a FRESH element on every navigation: the nav survived, its scroll didn't.
	 * So the component owns the behavior, skin-agnostically: per navigation it re-finds the live
	 * scroller (itself if scrollable, else the nearest scrollable ancestor), restores the
	 * session-saved position, keeps saving on scroll, and — the docs-site contract — centers the
	 * active row whenever it would otherwise sit outside the visible window (deep links land
	 * centered too, since a fresh load has nothing saved). The hidden mobile clone (the Sheet's
	 * instance) skips all of it via the `offsetParent` gate.
	 */
	let nav_el: HTMLElement | null = $state(null);
	let scroller: HTMLElement | null = null;
	const save = () => {
		if (scroller) {
			try {
				sessionStorage.setItem(`og:sidenav:${the_base}`, String(scroller.scrollTop));
			} catch {
				/* private mode */
			}
		}
	};
	function find_scroller(from: HTMLElement): HTMLElement | null {
		let el: HTMLElement | null = from;
		while (el && el !== document.body) {
			const o = getComputedStyle(el).overflowY;
			if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el;
			el = el.parentElement;
		}
		return null;
	}
	let first_sync = true;
	$effect(() => {
		void path; // re-run per navigation (props push into the kept app)
		const el = nav_el;
		if (!el || el.offsetParent === null) return;
		// The panel is a new element each nav — rebind the saver to the live one.
		const s = find_scroller(el);
		if (s !== scroller) {
			scroller?.removeEventListener('scroll', save);
			scroller = s;
			scroller?.addEventListener('scroll', save, { passive: true });
		}
		if (!scroller) return;
		let saved: number | null = null;
		try {
			const raw = sessionStorage.getItem(`og:sidenav:${the_base}`);
			saved = raw == null ? null : Number(raw);
		} catch {
			/* private mode */
		}
		if (saved != null && Number.isFinite(saved)) scroller.scrollTop = saved;
		// Center the active row when it sits outside the window (scroller-relative math — never
		// scrollIntoView, which would drag the PAGE scroll along with it).
		const active = el.querySelector<HTMLElement>('[aria-current="page"]');
		if (active) {
			const s_rect = scroller.getBoundingClientRect();
			const a_rect = active.getBoundingClientRect();
			const outside = a_rect.top < s_rect.top || a_rect.bottom > s_rect.bottom;
			if (outside || (first_sync && saved == null)) {
				const target =
					scroller.scrollTop + (a_rect.top - s_rect.top) - s_rect.height / 2 + a_rect.height / 2;
				scroller.scrollTo({
					top: Math.max(0, target),
					behavior: first_sync ? 'instant' : 'smooth'
				});
				save();
			}
		}
		first_sync = false;
	});
</script>

{#snippet items(list: NavTree)}
	<ul class="og-nav-list">
		{#each list as node (node.kind === 'link' ? `L${node.href}` : node.kind === 'group' ? `G${node.label}` : node.slug)}
			{#if node.kind === 'group'}
				<li class="og-nav-group">
					<span class="og-nav-label" style="view-transition-name: {vt_name('phg', node.label)}">{node.label}{#if node.badge}<span class="og-badge">{node.badge}</span>{/if}</span>
					{@render items(node.items)}
				</li>
			{:else if node.kind === 'link'}
				<li><a class="og-nav-link og-nav-external" style="view-transition-name: {vt_name('phx', node.href)}" href={node.href}>{node.label}</a></li>
			{:else if item}
				<li>{@render item(node, path === node.href)}</li>
			{:else}
				<li>
					<a class="og-nav-link" class:og-active={path === node.href} aria-current={path === node.href ? 'page' : undefined} href={node.href} style="view-transition-name: {vt_name('phl', node.href)}">
						<!-- The gliding highlight box: only the ACTIVE row carries it, and it holds
						     `view-transition-name: og-nav-active` (in CSS), so the page cross-fade's View
						     Transition slides it from the old active row to the new one. It sits BEHIND the
						     label text and beneath every row's own VT layer (z-index), so it never clips a label. -->
						{#if path === node.href}<span class="og-nav-chip" aria-hidden="true"></span>{/if}
						{node.title}{#if node.badge}<span class="og-badge">{node.badge}</span>{/if}
					</a>
				</li>
			{/if}
		{/each}
	</ul>
{/snippet}

<!-- Roving tabindex: the sidebar is ONE tab stop; Up/Down move between links (entry lands on the
     active page's link). Focus-only — Enter/click navigate natively. -->
<nav
	class="og-sidebar"
	aria-label="Documentation"
	bind:this={nav_el}
	{@attach roving({ selector: '.og-nav-link', orientation: 'vertical' })}
>
	{@render items(tree)}
</nav>
