<script lang="ts">
	/**
	 * BlogShell — the blog FORM, sibling of the docs `Shell`. Same header bricks (brand, links, search,
	 * theme, actions) but a CENTERED single-column body: no sidebar, no on-this-page rail. A blog reads
	 * top to bottom, so `<BlogList>` (index) and `<BlogPost>` (a post) render straight into `children`.
	 *
	 * Styling is OPT-IN exactly like `Shell` — import `ogygia/content/theme.css` + `ogygia/content/shell.css`
	 * for the header chrome, and the scoped blog layout below fills the rest. Needs no `site`: a blog's
	 * header is just links, so nothing here imports the corpus.
	 */
	import { page } from '$app/state';
	import { script } from '../../../script.js';
	import { set_shell_context } from '../context.js';
	import { mountBase } from '../site.js';
	import Search from './Search.svelte' with { wake: 'idle' };
	import ThemeToggle from './ThemeToggle.svelte' with { wake: 'load' };
	import type { Snippet } from 'svelte';

	let {
		title = 'Blog',
		base,
		links = [],
		search = false,
		brand,
		actions,
		children
	}: {
		/** Brand text + `<title>` suffix. */
		title?: string;
		/** Mount prefix (the blog's root, e.g. `/blog`); default derived from the current page. */
		base?: string;
		/** Header nav links. */
		links?: { text: string; href: string }[];
		/** Show the ⌘K search trigger (needs a `search` remote / static index wired app-side). */
		search?: boolean;
		/** Brand region (logo/wordmark); default `title`. */
		brand?: Snippet;
		/** Header tools — socials, RSS, a subscribe button. */
		actions?: Snippet;
		children: Snippet;
	} = $props();

	// svelte-ignore state_referenced_locally
	const the_base = base ?? mountBase(page.url, page.params.slug ?? '');
	// svelte-ignore state_referenced_locally
	set_shell_context({ base: the_base, title });
</script>

<svelte:head>
	{@html script((k: string) => {
		try {
			var t = localStorage.getItem(k);
			if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
		} catch (e) {
			/* private */
		}
	}, 'og-theme')}
</svelte:head>

<div class="og-blogshell">
	<a class="og-skip" href="#og-main">Skip to content</a>
	<header class="og-bheader">
		<div class="og-bheader-inner">
			<a class="og-bheader-brand" href={the_base || '/'}>{#if brand}{@render brand()}{:else}{title}{/if}</a>
			<nav class="og-bheader-nav" aria-label="Primary">
				{#each links as l (l.href)}<a class="og-bheader-link" href={l.href}>{l.text}</a>{/each}
			</nav>
			<div class="og-bheader-tools">
				{#if search}<div class="og-bheader-search"><Search base={the_base} /></div>{/if}
				<ThemeToggle />
				{#if actions}<div class="og-bheader-actions">{@render actions()}</div>{/if}
			</div>
		</div>
	</header>

	<main class="og-bmain" id="og-main" tabindex="-1">{@render children()}</main>
</div>

<style>
	.og-blogshell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}
	.og-skip {
		position: absolute;
		left: -999px;
	}
	.og-skip:focus {
		left: 1rem;
		top: 1rem;
		z-index: 10;
	}
	.og-bheader {
		border-bottom: 1px solid var(--og-border);
		background: color-mix(in oklab, var(--og-bg, Canvas) 88%, transparent);
		backdrop-filter: blur(8px);
		position: sticky;
		top: 0;
		z-index: 5;
	}
	.og-bheader-inner {
		max-width: 52rem;
		margin: 0 auto;
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 1.25rem;
	}
	.og-bheader-brand {
		font-weight: 700;
		font-size: 1.05rem;
		letter-spacing: -0.01em;
		text-decoration: none;
		color: var(--og-text);
	}
	.og-bheader-nav {
		display: flex;
		gap: 1rem;
	}
	.og-bheader-link {
		font-size: 0.9rem;
		color: var(--og-text-dim);
		text-decoration: none;
	}
	.og-bheader-link:hover {
		color: var(--og-text);
	}
	.og-bheader-tools {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.og-bmain {
		flex: 1;
		width: 100%;
		padding: 3rem 0 5rem;
	}
</style>
