<script lang="ts">
	import { page } from '$app/state';
	import { Search } from 'ogygia/content';
	import Sidebar from '$lib/Sidebar.svelte';
	import { TOPICS, topicFromPath } from '$lib/topics';

	const path = $derived(page.url.pathname);
	const on_docs = $derived(path.startsWith('/docs'));
	const on_blog = $derived(path.startsWith('/blog'));
	const topic = $derived(topicFromPath(path));

	// ── svelte.dev's mobile nav behavior (the original bottom bar): hide on scroll down, show on
	// scroll up or near the top; a hash jump must not toggle it. Desktop ignores `visible` entirely
	// (the transform rule lives inside the mobile media query).
	let visible = $state(true);
	let open = $state(false);
	let menu_button: HTMLButtonElement | undefined;

	let hash_changed = false;
	let last_scroll = 0;
	function handle_scroll() {
		const scroll = window.scrollY;
		if (!hash_changed) {
			visible = scroll === last_scroll ? visible : scroll < 50 || scroll < last_scroll;
		}
		last_scroll = scroll;
		hash_changed = false;
	}

	function handle_key(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			open = false;
			menu_button?.focus();
		}
	}

	// Lock the page while the drawer is open.
	$effect(() => {
		document.body.style.overflow = open ? 'hidden' : '';
		return () => {
			document.body.style.overflow = '';
		};
	});

	// A nav (link tap in the drawer) closes it.
	$effect(() => {
		void path;
		open = false;
	});

	// ── font toggle (svelte.dev's "elegant" serif ↔ "boring" Atkinson) — same storage key as theirs.
	let font = $state<'elegant' | 'boring'>('elegant');
	$effect(() => {
		try {
			font = (localStorage.getItem('svelte:font') as 'elegant' | 'boring') ?? 'elegant';
		} catch {
			/* private mode */
		}
	});
	function toggle_font() {
		font = font === 'elegant' ? 'boring' : 'elegant';
		document.documentElement.classList.remove('font-elegant', 'font-boring');
		document.documentElement.classList.add(`font-${font}`);
		try {
			localStorage.setItem('svelte:font', font);
		} catch {
			/* private mode */
		}
	}
</script>

<svelte:window onscroll={handle_scroll} onkeydown={handle_key} onhashchange={() => (hash_changed = true)} />

{#if open}
	<div class="menu-backdrop" onclick={() => (open = false)} aria-hidden="true"></div>
	<div class="mobile-menu" role="dialog" aria-label="Menu">
		<nav class="menu-links" aria-label="Primary">
			<a href="/docs" class:active={on_docs}>Docs</a>
			<a href="/blog" class:active={on_blog}>Blog</a>
		</nav>
		{#if on_docs}
			<div class="menu-docs"><Sidebar /></div>
		{/if}
	</div>
{/if}

<header class="nav" class:visible>
	<a class="home" href="/" aria-label="Homepage">
		<!-- explicit sizes: island CSS lands after first paint; unsized imgs would flash full-width -->
		<img class="wordmark light-only" src="/svelte.svg" alt="Svelte" width="107" height="30" />
		<img class="wordmark dark-only" src="/svelte-dark.svg" alt="Svelte" width="107" height="30" />
	</a>

	<nav class="links" aria-label="Primary">
		<!-- the dimension selector — a POPUP menu on the Docs link (svelte.dev's model), not a tab bar -->
		<div class="menu-host">
			<a href="/docs" class:active={on_docs} aria-haspopup="true">
				Docs
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
			</a>
			<div class="popup" role="menu">
				{#each TOPICS as t (t.key)}
					<a role="menuitem" href={t.href} aria-current={on_docs && topic === t.key ? 'page' : undefined}>{t.label}</a>
				{/each}
			</div>
		</div>
		<a href="/blog" class:active={on_blog}>Blog</a>
	</nav>

	<div class="controls">
		<div class="search-slot"><Search base="/docs" placeholder="search" /></div>

		<a class="brand-icon" href="https://discord.gg/svelte" aria-label="Discord" title="Discord">
			<svg viewBox="0 0 127.14 96.36" width="22" height="17" aria-hidden="true"><path fill="currentColor" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
		</a>
		<a class="brand-icon" href="https://bsky.app/profile/svelte.dev" aria-label="Bluesky" title="Bluesky">
			<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.468 1.948C5.303 3.325 7.276 6.118 8 7.616c.725-1.498 2.697-4.29 4.532-5.668C13.855.955 16 .186 16 2.632c0 .489-.28 4.105-.444 4.692-.572 2.04-2.653 2.561-4.504 2.246 3.236.551 4.06 2.375 2.281 4.2-3.376 3.464-4.852-.87-5.23-1.98-.07-.204-.103-.3-.103-.218 0-.081-.033.014-.102.218-.379 1.11-1.855 5.444-5.231 1.98-1.778-1.825-.955-3.65 2.28-4.2-1.85.315-3.932-.205-4.503-2.246C.28 6.737 0 3.12 0 2.632 0 .186 2.145.955 3.468 1.948Z"/></svg>
		</a>
		<a class="brand-icon" href="https://github.com/sveltejs/svelte" aria-label="GitHub" title="GitHub">
			<svg viewBox="0 0 98 96" width="19" height="19" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z"/></svg>
		</a>

		<button type="button" class="raised font-toggle" onclick={toggle_font} aria-pressed={font === 'boring'} aria-label="Toggle font">
			<span class="font-glyph" class:serif={font === 'elegant'}>A</span>
		</button>
		<button type="button" class="raised" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">
			<svg class="light-only" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
			</svg>
			<svg class="dark-only" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
			</svg>
		</button>
		<button
			type="button"
			class="raised menu-toggle"
			bind:this={menu_button}
			aria-expanded={open}
			aria-label={open ? 'Close menu' : 'Open menu'}
			onclick={() => (open = !open)}
		>
			{#if open}
				<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
			{:else}
				<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
			{/if}
		</button>
	</div>
</header>

<style>
	.nav {
		position: sticky;
		top: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		gap: 2.4rem;
		height: var(--sk-nav-height);
		padding: 0 var(--sk-page-padding-side);
		background: var(--sk-bg-1);
		isolation: isolate;
	}
	/* svelte.dev separates the nav with a 4px shadow GRADIENT, not a border */
	.nav::after {
		content: '';
		position: absolute;
		left: 0;
		top: 100%;
		width: 100%;
		height: 4px;
		background: linear-gradient(to bottom, rgba(0, 0, 0, 0.05), transparent);
	}
	:global(:root.dark) .nav {
		background: var(--sk-bg-3);
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not(.light):not(.dark)) .nav {
			background: var(--sk-bg-3);
		}
	}

	.home {
		display: flex;
		align-items: center;
	}
	.wordmark {
		height: 3rem;
		width: auto;
	}
	:global(:root:not(.dark)) .dark-only {
		display: none;
	}
	:global(:root.dark) .light-only {
		display: none;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not(.light):not(.dark)) .light-only {
			display: none;
		}
		:global(:root:not(.light):not(.dark)) .dark-only {
			display: initial !important;
		}
	}

	.links {
		display: flex;
		align-items: center;
		gap: 1.6rem;
		font: var(--sk-font-ui-medium);
	}
	.links a,
	.menu-links a {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--sk-fg-2);
		text-decoration: none;
		padding: 0.4rem 0;
	}
	.links a:hover,
	.menu-links a:hover {
		color: var(--sk-fg-1);
		text-decoration: none;
	}
	.links a.active,
	.menu-links a.active {
		color: var(--sk-fg-accent);
		border-bottom: 1px solid currentColor;
	}

	/* the topic POPUP (dimension selector) — opens on hover / keyboard focus */
	.menu-host {
		position: relative;
	}
	.popup {
		position: absolute;
		top: 100%;
		left: -1rem;
		min-width: 16rem;
		padding: 0.6rem;
		display: none;
		flex-direction: column;
		background: var(--sk-bg-1);
		border: 1px solid var(--sk-border);
		border-radius: var(--sk-border-radius);
		box-shadow: var(--sk-shadow);
		z-index: 10;
	}
	.menu-host:hover .popup,
	.menu-host:focus-within .popup {
		display: flex;
	}
	.popup a {
		padding: 0.6rem 1rem;
		border-radius: var(--sk-border-radius-inner);
		border-bottom: none;
		color: var(--sk-fg-2);
	}
	.popup a:hover {
		background: var(--sk-bg-4);
		color: var(--sk-fg-1);
	}
	.popup a[aria-current='page'] {
		color: var(--sk-fg-accent);
	}

	.controls {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.8rem;
	}
	.controls :where(button, a.brand-icon) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.2rem;
		height: 3.2rem;
		color: var(--sk-fg-3);
		background: transparent;
	}
	.controls button {
		background: var(--sk-bg-1);
	}
	:global(:root.dark) .controls button {
		background: var(--sk-bg-3);
	}
	.controls :where(button, a.brand-icon):hover {
		color: var(--sk-fg-1);
		text-decoration: none;
	}
	/* uniform icon sizing across the cluster (brand icons + toggles read as one family) */
	.brand-icon svg {
		height: 1.9rem;
		width: auto;
	}
	.font-glyph {
		font: 500 1.9rem/1 var(--sk-font-family-ui);
	}
	.font-glyph.serif {
		font-family: var(--sk-font-family-heading);
	}

	/* search trigger sizing lives in content.css (.og-search-trigger) */
	.search-slot {
		margin-right: 0.4rem;
	}

	/* must out-specify `.controls button`-level rules */
	.controls .menu-toggle {
		display: none;
	}

	/* ── the original mobile bottom bar (thumb-reachable; hides on scroll down, shows on scroll up) ── */
	@media (max-width: 831px) {
		.nav {
			position: fixed;
			top: unset;
			bottom: 0;
			left: 0;
			right: 0;
			padding-bottom: env(safe-area-inset-bottom);
			height: calc(var(--sk-nav-height) + env(safe-area-inset-bottom));
			transition: transform 0.2s;
		}
		/* bottom-pinned → the shadow gradient sits ABOVE the bar (their exact ::after) */
		.nav::after {
			top: -4px;
			background: linear-gradient(to top, rgba(0, 0, 0, 0.05), transparent);
		}
		.nav:not(.visible):not(:focus-within) {
			transform: translate(0, calc(var(--sk-nav-height) + env(safe-area-inset-bottom)));
		}
		.links {
			display: none;
		}
		.search-slot,
		.brand-icon {
			display: none;
		}
		.controls .menu-toggle {
			display: flex;
		}
	}

	/* ── the drawer: a panel sliding up from the bar, docs tree inside ── */
	.menu-backdrop {
		position: fixed;
		inset: 0;
		z-index: 98;
		background: rgba(0, 0, 0, 0.3);
	}
	.mobile-menu {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--sk-nav-height) + env(safe-area-inset-bottom));
		top: 20vh;
		z-index: 99;
		display: flex;
		flex-direction: column;
		background: var(--sk-bg-1);
		border-top: 1px solid var(--sk-border);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.menu-links {
		display: flex;
		gap: 2rem;
		padding: 1.6rem var(--sk-page-padding-side);
		border-bottom: 1px solid var(--sk-border);
		font: var(--sk-font-ui-medium);
	}
	.menu-docs {
		flex: 1;
	}
	@media (min-width: 832px) {
		.menu-backdrop,
		.mobile-menu {
			display: none;
		}
	}
</style>
