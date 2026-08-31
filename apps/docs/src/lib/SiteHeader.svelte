<script lang="ts">
	// The ONE site header — full-width, on the homepage, the Observatory, and the docs alike. Composed
	// from the content-kit's own bricks (Search + ThemeToggle), so docs and marketing share one bar.
	// Logo hard-left, then a breadcrumb (`ogygia │ Docs` / `ogygia │ Observatory`; just `ogygia` on
	// home); actions hard-right. On docs it's passed to DocsShell as the `header` snippet (with
	// `tools={null}`), so the sidebar carries only the nav.
	import Logo from '$lib/Logo.svelte';
	import { Search, ThemeToggle } from 'ogygia/content';
	// Named barrel imports → asRegion turns each into its own island (Search's ⌘K palette lazy-loads on
	// first intent; ThemeToggle writes data-theme + the og-theme key).
	const SearchBox = import.meta.og.asRegion(Search, { wake: 'idle' });
	const Theme = import.meta.og.asRegion(ThemeToggle, { wake: 'load' });

	let { section = null }: { section?: string | null } = $props();
</script>

<header class="site-nav">
	<div class="site-nav-inner">
		<a class="site-brand" href="/" aria-label="ogygia home">
			<Logo size={22} decorative />
			<span class="site-brand-word">ogygia</span>
		</a>
		{#if section}
			<span class="site-sep" aria-hidden="true">│</span>
			<span class="site-crumb">{section}</span>
		{/if}

		<div class="site-actions">
			<div class="site-search"><SearchBox base="/docs" placeholder="Search docs" /></div>
			<nav class="site-links" aria-label="Primary">
				<a href="/docs/start/install">Docs</a>
				<a href="/observatory">Observatory</a>
				<a href="/playground/getting-started/installation">Playground</a>
			</nav>
			<Theme />
			<a
				class="site-gh"
				href="https://github.com/PuruVJ/ogygia"
				target="_blank"
				rel="noreferrer"
				aria-label="GitHub repository"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
					><path
						d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
					/></svg
				>
			</a>
		</div>
	</div>
</header>

<style>
	/* Full-width, sharing the floating panel's MATERIAL (frosted glass over a raised surface, a faint
	   accent glow at the top edge, an accent hairline, and the panel's soft float shadow) so the header
	   and sidebar read as one chrome — without the header itself floating. */
	/* FIXED, not sticky — the macOS rubber-band overscroll drags sticky elements with the document but
	   leaves fixed ones pinned (like the sidebar), so the header stays put during the elastic recoil. */
	.site-nav {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 60;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--accent-deep) 26%, transparent) 0%,
				transparent 78%
			),
			color-mix(in srgb, var(--bg-raised) 78%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--accent-line) 50%, var(--line));
		/* Subtle depth now the sidebar is flat — not the panel's big float shadow. */
		box-shadow: 0 2px 10px -8px color-mix(in srgb, var(--accent-deep) 45%, rgba(0, 0, 0, 0.4));
		backdrop-filter: blur(16px) saturate(1.25);
		-webkit-backdrop-filter: blur(16px) saturate(1.25);
	}
	/* Full-width: logo pinned left, actions pinned right, only slim gutters. */
	.site-nav-inner {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		height: 3.5rem;
		padding: 0 1.5rem;
	}
	.site-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text);
		text-decoration: none;
	}
	.site-brand-word {
		font: 600 1.1rem/1 var(--font-display);
		letter-spacing: -0.02em;
	}
	.site-sep {
		color: var(--text-faint);
		font-size: 1.15rem;
		font-weight: 300;
	}
	.site-crumb {
		color: var(--text-dim);
		font: 500 0.98rem/1 var(--font-body);
		letter-spacing: -0.01em;
	}
	.site-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 1.35rem;
	}
	.site-links {
		display: flex;
		align-items: center;
		gap: 1.5rem;
	}
	.site-links a {
		color: var(--text-dim);
		text-decoration: none;
		font: 500 0.9rem/1 var(--font-body);
		transition: color 120ms ease;
	}
	.site-links a:hover {
		color: var(--text);
	}
	.site-gh {
		display: inline-flex;
		color: var(--text-faint);
		transition: color 120ms ease;
	}
	.site-gh:hover {
		color: var(--text);
	}
	@media (max-width: 720px) {
		.site-nav-inner {
			padding: 0 1rem;
			gap: 0.6rem;
		}
		.site-links {
			display: none;
		}
	}
</style>
