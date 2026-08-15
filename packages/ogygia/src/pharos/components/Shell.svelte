<script lang="ts">
	/**
	 * Shell — the batteries-included SHELL: the VitePress FORM of pharos. Not a new skin (theme.css owns the
	 * design language); an opinionated COMPOSITION of the same public bricks. Desktop: top header
	 * (brand, links, search, theme) + left sidebar + content (Doc brings its own on-this-page rail).
	 * Mobile: a bottom bar + slide-up sheet (bottom-first by default), all in one island (`ShellBar`).
	 *
	 * Styling is OPT-IN — Shell ships STRUCTURE + `.ph-*` hooks and imports NO CSS. Want the pharos
	 * look? Import the two stylesheets once (e.g. in your root layout); want your own? Don't, and style
	 * the `.ph-*` classes yourself. You only pay for the CSS you ask for.
	 *   import 'ogygia/pharos/theme.css';    // the design language (tokens + element styles)
	 *   import 'ogygia/pharos/shell.css';  // this shell's layout (header + sidebar + content grid)
	 *   <Shell {site}>{@render children()}</Shell>
	 */
	import { page } from '$app/state';
	import { script } from '../../script.js';
	import { set_shell_context } from '../context.js';
	import { mountBase, type Site, type SiteMeta } from '../pharos.js';
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
	// TODO(keep): persisting this across nav (`keep: 'ph-shell-bar'`) fixes the benign
	// `hydration_html_changed` warning, but its relocation currently throws a HierarchyRequestError on
	// hydrate — the Sheet backdrop + portable `actions` snippet aren't keep-safe yet. Left re-hydrating.
	import ShellBar from './ShellBar.svelte' with { wake: 'load' };
	import type { NavTree } from '../types.js';
	import type { Snippet } from 'svelte';

	let {
		site,
		meta,
		title = 'Docs',
		links = [],
		base,
		skip,
		header,
		brand,
		side,
		tools,
		sidebar,
		bar,
		actions,
		children
	}: {
		/** The site brains. Pass it and the Shell computes its nav/switcher itself (the simple path).
		 *  OR keep the corpus SERVER-ONLY and pass `meta` DATA instead (the leak-free path) — then no
		 *  route imports the corpus. Exactly one of `site` / `meta` is needed. */
		site?: Site;
		/** The pre-computed shell bundle from `site.meta(slug)` — the leak-free path. When present, the
		 *  Shell uses it and never touches `site`, so a `+layout.svelte` can feed a `meta` remote's
		 *  result and keep the corpus off the client. */
		meta?: SiteMeta;
		/** Brand text in the header (used when the `brand` snippet is absent). */
		title?: string;
		/** Top-nav links (data — they cross into the mobile island, which snippets can't). */
		links?: { text: string; href: string }[];
		/** Mount prefix override; default derived by subtraction from the current page. */
		base?: string;
		/** ONE pattern, all the way down: every region the Shell renders is a conditional snippet.
		 *  Absent → the built-in renders. Present → yours renders instead. Empty → the region is gone.
		 *  The regions nest — replace the whole `header`, or keep it and replace just its `brand`,
		 *  `nav`, or `tools` — and each default bottoms out at composable public bricks. */
		/** The skip-to-content link (first tab stop). Default: "Skip to content" → `#ph-main`. */
		skip?: Snippet;
		/** The whole top header. Empty snippet → NO header, and the Shell shifts to the panel-chrome
		 *  form: the tools cluster renders INSIDE the sidebar above the nav, so nothing is lost. */
		header?: Snippet;
		/** The header's brand region. Default: `<a>` to the mount root carrying `title`. */
		brand?: Snippet;
		/** The header's primary-nav region. Default: a link row from `links`. */
		nav?: Snippet;
		/** The tools cluster (search, switchers, theme, `actions`) — wherever it lives: the built-in
		 *  header in header mode, the sidebar panel when the header is replaced. */
		tools?: Snippet;
		/** Rendered at the TOP of the sidebar, above tools + nav — the panel's brand row. */
		side?: Snippet;
		/** The sidebar NAV. Default: the built-in `<Sidebar>` (kept island — roving focus, gliding
		 *  marker). The snippet gets the computed `NavTree` + mount base, so a bespoke sidenav needs
		 *  no extra data plumbing. */
		sidebar?: Snippet<[NavTree, string]>;
		/** The mobile chrome (bottom bar + sheet). Default: the built-in `<ShellBar>` island. */
		bar?: Snippet<[NavTree, string]>;
		/** Header tools — GitHub, version switcher, socials, anything. Rendered in the desktop header.
		 *  NOT (yet) in the mobile sheet: `actions` is a forwarded snippet-prop, and a forwarded snippet
		 *  can't cross into the `ShellBar` island (it captures as a function → not serializable). The
		 *  fix is to make the mobile sheet SSR + inline-script (non-island) so snippets flow through. */
		actions?: Snippet;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	const the_base = base ?? mountBase(page.url, page.params.slug ?? '');
	// svelte-ignore state_referenced_locally
	set_shell_context({ site, base: the_base, components: site?.components, title });

	// svelte-ignore state_referenced_locally
	const current_slug = page.params.slug ?? '';
	// One nav computation shared by the desktop sidebar and the mobile island (as data). Use the
	// pre-computed `meta` bundle when given (leak-free); else compute from the live `site`.
	// On a `dimensions()` site the slug selects the coordinate's tree; ignored on a plain site.
	const tree: NavTree = meta ? meta.nav : await site!.nav({ base: the_base, slug: current_slug });
	// The version/locale switcher (plain data → native links; `null` on a non-dimensioned site).
	const switcher = meta ? meta.switcher : site ? await site.switcher(current_slug, { base: the_base }) : null;
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

<div class="ph-shell" class:ph-headerless={!!header}>
	<!-- Every region below follows ONE pattern: {#if snippet}{@render snippet()}{:else}built-in{/if}.
	     Absent = batteries-included; present = yours; empty = gone. -->
	{#if skip}{@render skip()}{:else}
		<!-- First focusable element: keyboard users jump past the nav straight to the content. -->
		<a class="ph-skip" href="#ph-main">Skip to content</a>
	{/if}
	{#if header}
		{@render header()}
	{:else}
		<header class="ph-cheader">
			{#if brand}{@render brand()}{:else}
				<a class="ph-cheader-brand" href={the_base || '/'}>{title}</a>
			{/if}
			<!-- Version sits by the brand (it scopes the whole doc set); locale rides with the tools. -->
			{#if switcher}<Switcher {switcher} for="version" />{/if}
			{#if nav}{@render nav()}{:else}
				<nav class="ph-cheader-nav" aria-label="Primary">
					{#each links as l (l.href)}<a class="ph-cheader-link" href={l.href}>{l.text}</a>{/each}
				</nav>
			{/if}
			{#if tools}{@render tools()}{:else}
				<div class="ph-cheader-tools">
					<div class="ph-cheader-search"><Search base={the_base} /></div>
					{#if switcher}<Switcher {switcher} for="locale" />{/if}
					<ThemeToggle />
					{#if actions}<div class="ph-cheader-actions">{@render actions()}</div>{/if}
				</div>
			{/if}
		</header>
	{/if}

	<div class="ph-cframe">
		<aside class="ph-cside" aria-label="Documentation">
			{#if side}<div class="ph-cside-brand">{@render side()}</div>{/if}
			{#if header}
				<!-- The app took over the header, so the panel carries the tools it would have held.
				     Search's ⌘K keybinding + palette work exactly the same from here. -->
				{#if tools}{@render tools()}{:else}
					<div class="ph-cside-tools">
						{#if switcher}<Switcher {switcher} for="version" />{/if}
						<div class="ph-cside-search"><Search base={the_base} /></div>
						{#if switcher}<Switcher {switcher} for="locale" />{/if}
						<ThemeToggle />
						{#if actions}<div class="ph-cside-actions">{@render actions()}</div>{/if}
					</div>
				{/if}
			{/if}
			{#if sidebar}
				{@render sidebar(tree, the_base)}
			{:else}
				<Sidebar nav={tree} base={the_base} />
			{/if}
		</aside>
		<main class="ph-cmain" id="ph-main" tabindex="-1">{@render children()}</main>
	</div>

	<!-- The mobile island. `actions` is a portable snippet (the compiler made it one at the consumer's
	     call site), so it crosses into the island as a descriptor and comes alive in the sheet footer. -->
	{#if bar}
		{@render bar(tree, the_base)}
	{:else}
		<ShellBar nav={tree} base={the_base} brand={title} {actions} />
	{/if}
</div>
