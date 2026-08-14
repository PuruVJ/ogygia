<script lang="ts">
	/**
	 * Calypso — a named SHELL: the VitePress FORM of pharos. Not a new skin (theme.css owns the
	 * design language); an opinionated COMPOSITION of the same public bricks. Desktop: top header
	 * (brand, links, search, theme) + left sidebar + content (Doc brings its own on-this-page rail).
	 * Mobile: a bottom bar + slide-up sheet (bottom-first by default), all in one island (`CalypsoBar`).
	 *
	 * Styling is OPT-IN — Calypso ships STRUCTURE + `.ph-*` hooks and imports NO CSS. Want the pharos
	 * look? Import the two stylesheets once (e.g. in your root layout); want your own? Don't, and style
	 * the `.ph-*` classes yourself. You only pay for the CSS you ask for.
	 *   import 'ogygia/pharos/theme.css';    // the design language (tokens + element styles)
	 *   import 'ogygia/pharos/calypso.css';  // this shell's layout (header + sidebar + content grid)
	 *   <Calypso {site}>{@render children()}</Calypso>
	 */
	import { page } from '$app/state';
	import { script } from '../../script.js';
	import { set_shell_context } from '../context.js';
	import { mountBase, type Site } from '../pharos.js';
	// KEPT island: the live sidebar (DOM + mounted app) rides the body-swap across nav instead of
	// re-rendering, so its active-marker element persists and can GLIDE to the new row. `nav`/`base` are
	// plain serializable data, so they cross the island boundary cleanly.
	import Sidebar from './Sidebar.svelte' with { wake: 'load', keep: 'ph-sidebar' };
	// The desktop header is SSR-only on csr=false — these must be islands to come alive. Switcher is a
	// Bits UI DropdownMenu (needs JS); it re-hydrates per nav so the picker stays live after a body-swap.
	import Switcher from './Switcher.svelte' with { wake: 'load' };
	// Search's ⌘K palette hydrates when idle.
	import Search from './Search.svelte' with { wake: 'idle' };
	// Island so the theme click re-wires after every SPA nav (a one-shot script would go stale).
	import ThemeToggle from './ThemeToggle.svelte' with { wake: 'load' };
	// TODO(keep): persisting this across nav (`keep: 'ph-calypso-bar'`) fixes the benign
	// `hydration_html_changed` warning, but its relocation currently throws a HierarchyRequestError on
	// hydrate — the Sheet backdrop + portable `actions` snippet aren't keep-safe yet. Left re-hydrating.
	import CalypsoBar from './CalypsoBar.svelte' with { wake: 'load' };
	import type { NavTree } from '../types.js';
	import type { Snippet } from 'svelte';

	let {
		site,
		title = 'Docs',
		links = [],
		base,
		brand,
		actions,
		children
	}: {
		site: Site;
		/** Brand text in the header (used when the `brand` snippet is absent). */
		title?: string;
		/** Top-nav links (data — they cross into the mobile island, which snippets can't). */
		links?: { text: string; href: string }[];
		/** Mount prefix override; default derived by subtraction from the current page. */
		base?: string;
		/** The brand region (logo/wordmark). Default: `title`. */
		brand?: Snippet;
		/** Header tools — GitHub, version switcher, socials, anything. Rendered in the desktop header.
		 *  NOT (yet) in the mobile sheet: `actions` is a forwarded snippet-prop, and a forwarded snippet
		 *  can't cross into the `CalypsoBar` island (it captures as a function → not serializable). The
		 *  fix is to make the mobile sheet SSR + inline-script (non-island) so snippets flow through. */
		actions?: Snippet;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	const the_base = base ?? mountBase(page.url, page.params.slug ?? '');
	// svelte-ignore state_referenced_locally
	set_shell_context({ site, base: the_base, components: site.components, title });

	// svelte-ignore state_referenced_locally
	const current_slug = page.params.slug ?? '';
	// One nav computation (server-side), shared by the desktop sidebar and the mobile island (as data).
	// On a `dimensions()` site the slug selects the coordinate's tree; ignored on a plain site.
	const tree: NavTree = await site.nav({ base: the_base, slug: current_slug });
	// The version/locale switcher (plain data → native links; `null` on a non-dimensioned site).
	const switcher = await site.switcher(current_slug, { base: the_base });
</script>

<svelte:head>
	{@html script((k: string) => {
		try {
			var t = localStorage.getItem(k);
			if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
		} catch (e) {
			/* private */
		}
	}, 'ph-theme')}
</svelte:head>

<div class="ph-calypso">
	<!-- First focusable element: keyboard users jump past the nav straight to the content. -->
	<a class="ph-skip" href="#ph-main">Skip to content</a>
	<header class="ph-cheader">
		<a class="ph-cheader-brand" href={the_base || '/'}>{#if brand}{@render brand()}{:else}{title}{/if}</a>
		<!-- Version sits by the brand (it scopes the whole doc set); locale rides with the tools. -->
		{#if switcher}<Switcher {switcher} for="version" />{/if}
		<nav class="ph-cheader-nav" aria-label="Primary">
			{#each links as l (l.href)}<a class="ph-cheader-link" href={l.href}>{l.text}</a>{/each}
		</nav>
		<div class="ph-cheader-tools">
			<div class="ph-cheader-search"><Search base={the_base} /></div>
			{#if switcher}<Switcher {switcher} for="locale" />{/if}
			<ThemeToggle />
			{#if actions}<div class="ph-cheader-actions">{@render actions()}</div>{/if}
		</div>
	</header>

	<div class="ph-cframe">
		<aside class="ph-cside" aria-label="Documentation">
			<Sidebar nav={tree} base={the_base} />
		</aside>
		<main class="ph-cmain" id="ph-main" tabindex="-1">{@render children()}</main>
	</div>

	<!-- The mobile island. `actions` is a portable snippet (the compiler made it one at the consumer's
	     call site), so it crosses into the island as a descriptor and comes alive in the sheet footer. -->
	<CalypsoBar nav={tree} base={the_base} brand={title} {actions} />
</div>
