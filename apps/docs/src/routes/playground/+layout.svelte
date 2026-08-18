<script lang="ts">
	// Dogfood the Shell. Header extras are a SNIPPET — it renders in the desktop header and,
	// because the compiler makes a forwarded snippet PORTABLE, crosses into the mobile island's sheet
	// footer and comes alive there.
	import DocsShell from 'ogygia/content/docs-shell';
	// Styling is OPT-IN: the Shell ships no CSS, so we import the ogygia look explicitly.
	// FORM + LANGUAGE compose: shell.css is the building blocks (layout only); the LANGUAGE is one
	// of nine zen-garden theme files, loaded via a swappable <link> (see <svelte:head>) so the
	// floating ThemePicker can switch skins at runtime. Thalassa is the default.
	// (The STOCK pair still works too: `import 'ogygia/content/theme.css'` BEFORE shell.css.)
	import 'ogygia/content/shell.css'; // the FORM: header + sidebar + content grid + mobile chrome
	import stock from 'ogygia/content/theme.css?url'; // the stock default language
	import thalassa from 'ogygia/content/themes/thalassa.css?url';
	import alexandria from 'ogygia/content/themes/alexandria.css?url';
	import pyros from 'ogygia/content/themes/pyros.css?url';
	import zephyros from 'ogygia/content/themes/zephyros.css?url';
	import selas from 'ogygia/content/themes/selas.css?url';
	import daidalos from 'ogygia/content/themes/daidalos.css?url';
	import kalliope from 'ogygia/content/themes/kalliope.css?url';
	import nephele from 'ogygia/content/themes/nephele.css?url';
	import ThemePicker from '$lib/playground/ThemePicker.svelte' with { wake: 'load' };
	const themes = { thalassa, stock, alexandria, pyros, zephyros, selas, daidalos, kalliope, nephele };
	// Self-hosted variable fonts — the theme references Inter / JetBrains Mono; point its tokens at the
	// `@fontsource-variable` family names below.
	import '@fontsource-variable/inter';
	import '@fontsource-variable/jetbrains-mono';
	// LEAK-FREE: the corpus lives in `docs.server.ts`; we pull only the shell bundle over the wire via
	// the `meta` remote and hand it to `<DocsShell {meta}>`. Nothing here imports the collections.
	import { page } from '$app/state';
	import { meta } from '$lib/playground/docs.remote';
	import { BlogShell } from 'ogygia/content';
	let { children } = $props();
	// The blog genre gets its OWN chrome (centered, no docs sidebar); everything else uses the docs
	// Shell. Branch here so the blog isn't double-wrapped, and skip the docs `meta` fetch on blog pages.
	const isBlog =
		page.url.pathname === '/playground/blog' || page.url.pathname.startsWith('/playground/blog/');
	const shellMeta = isBlog ? null : await meta(page.params.slug ?? '');
</script>

<svelte:head>
	<link id="pg-theme" rel="stylesheet" href={thalassa} />
</svelte:head>

<!-- body-level preload lives in the DOCS sub-app's chrome; this sub-app opts its own tree in -->
<div data-sveltekit-preload-data="hover" style="display: contents">
	{#if isBlog}
		<BlogShell base="/playground/blog" title="ogygia blog" links={[{ text: 'Playground', href: '/playground' }, { text: 'Docs', href: '/docs' }]}>
			{#snippet actions()}
				<a class="pg-gh" href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub ↗</a>
			{/snippet}
			{@render children()}
		</BlogShell>
	{:else}
		<DocsShell meta={shellMeta!} base="/playground" title="ogygia playground">
			{#snippet actions()}
				<a class="pg-gh" href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer"
					>GitHub ↗</a
				>
			{/snippet}
			{@render children()}
		</DocsShell>
	{/if}
	<ThemePicker {themes} />
</div>

<style>
	/* Stock-theme guard: it sets `display` on the mobile chrome; when swapped in AFTER shell.css
	   via the theme link, re-assert the form's desktop visibility (unlayered wins over @layer). */
	@media (min-width: 901px) {
		:global(.og-shell .og-bottombar),
		:global(.og-shell .og-sheet),
		:global(.og-shell .og-sheet-backdrop) {
			display: none;
		}
	}

	/* Unlayered → wins over `@layer ogygia` — repoint the theme's font tokens at the loaded families. */
	:global(:root) {
		--og-font: 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif;
		--og-mono: 'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	}
	:global(.pg-gh) {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--og-text-dim);
		text-decoration: none;
	}
	:global(.pg-gh:hover) {
		color: var(--og-text);
	}
</style>
