<script lang="ts">
	// Island: `data-ogygia-keep` preserves the sidebar DOM (and its scroll position) across SPA
	// body-swaps, while `wake: 'load'` re-hydrates it each nav so the active link tracks the page.
	import Sidebar from '$lib/Sidebar.svelte' with { wake: 'load' };
	import TwoslashHover from '$lib/TwoslashHover.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<div class="docs-shell">
	<aside class="docs-sidebar" data-ogygia-keep="docs-sidebar"><Sidebar /></aside>
	<div class="docs-main">{@render children()}</div>
</div>
<TwoslashHover />

<style>
	.docs-shell {
		display: grid;
		/* the sidebar COLUMN grows with the viewport (content pushed toward center, svelte.dev's
		   proportions); the nav inside right-aligns against the boundary. NO divider border. */
		grid-template-columns: max(var(--sk-sidebar-width), calc(25vw - 2rem)) minmax(0, 1fr);
		align-items: start;
	}

	.docs-sidebar {
		position: sticky;
		top: var(--sk-nav-height);
		height: calc(100vh - var(--sk-nav-height));
		overflow-y: auto;
		overscroll-behavior: contain;
		/* light: slightly darkened vs the page (the counterpart of dark mode's lightened bg-0) */
		background: var(--sk-bg-3);
	}
	:global(:root.dark) .docs-sidebar {
		background: var(--sk-bg-0);
	}
	:global(:root:not(.light)) .docs-sidebar {
		@media (prefers-color-scheme: dark) {
			background: var(--sk-bg-0);
		}
	}

	.docs-main {
		min-width: 0;
	}

	@media (max-width: 831px) {
		.docs-shell {
			grid-template-columns: 1fr;
		}
		.docs-sidebar {
			display: none;
		}
	}
</style>
