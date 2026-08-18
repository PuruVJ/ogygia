<script lang="ts">
	// The homepage's own chrome: a slim sticky top-nav instead of the docs sidebar, so the landing
	// page reads as a marketing page with the full viewport to itself. Docs pages keep DocsShell.
	import Logo from '$lib/Logo.svelte';
	// ⌘K search over the docs index — an island so its keybinding + palette come alive here too.
	import HomeSearch from '$lib/HomeSearch.svelte' with { wake: 'load' };
</script>

<header class="mkt-nav">
	<div class="shell mkt-nav-inner">
		<a class="mkt-brand" href="/" aria-label="ogygia home">
			<Logo size={24} decorative />
			<span class="mkt-brand-word">ogygia</span>
		</a>
		<div class="mkt-search"><HomeSearch /></div>
		<nav class="mkt-links" aria-label="Primary">
			<a href="/docs/start/install">Docs</a>
			<a href="/playground/getting-started/installation">Playground</a>
			<a
				class="mkt-gh"
				href="https://github.com/PuruVJ/ogygia"
				target="_blank"
				rel="noreferrer"
				aria-label="GitHub repository"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
					><path
						d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
					/></svg
				>
				<span>GitHub</span>
			</a>
		</nav>
	</div>
</header>

<style>
	/* A fixed bar at the BOTTOM of the viewport, not the top. */
	.mkt-nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 50;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		backdrop-filter: saturate(1.4) blur(10px);
		-webkit-backdrop-filter: saturate(1.4) blur(10px);
	}
	.mkt-nav-inner {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		height: 3.75rem;
	}
	/* Push the search + links cluster to the right; brand stays left. */
	.mkt-search {
		margin-left: auto;
	}
	/* Search is an ICON button here, not the labelled box: hide the placeholder + kbd hint. */
	.mkt-search :global(.og-search-trigger-label),
	.mkt-search :global(.og-search-kbd) {
		display: none;
	}
	.mkt-search :global(.og-search-trigger) {
		min-width: 0;
		padding: 0.5rem;
		border-radius: 8px;
	}
	.mkt-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text);
		text-decoration: none;
	}
	.mkt-brand-word {
		font: 600 1.15rem/1 var(--font-display);
		letter-spacing: -0.02em;
	}
	.mkt-links {
		display: flex;
		align-items: center;
		gap: 1.6rem;
	}
	.mkt-links a {
		color: var(--text-dim);
		text-decoration: none;
		font: 500 0.9rem/1 var(--font-body);
		transition: color 120ms ease;
	}
	.mkt-links a:hover {
		color: var(--text);
	}
	.mkt-gh {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	@media (max-width: 560px) {
		.mkt-gh span {
			display: none;
		}
		.mkt-links {
			gap: 1.1rem;
		}
	}
</style>
