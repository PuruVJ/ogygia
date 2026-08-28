<script lang="ts">
	// The SHELL's chrome layout for router-mounted pages. Contains the shell's own island
	// (ShellNav) — proving shell + mounted-app islands coexist under ONE runtime, and
	// guaranteeing the runtime is present on mounted pages.
	import type { Snippet } from 'svelte';
	import ShellNav from './ShellNav.svelte' with { wake: 'load' };
	let { children }: { children: Snippet } = $props();
</script>

<main>
	<ShellNav />
	<p class="hint">shell chrome · everything in the purple box is served by the CMS app</p>
	{@render children()}
</main>

<style>
	main {
		max-width: 720px;
		margin: 2rem auto;
		font-family: system-ui, sans-serif;
	}
	.hint {
		color: #6b7280;
		font-size: 0.85rem;
	}
</style>
