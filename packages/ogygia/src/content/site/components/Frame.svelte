<script lang="ts">
	/**
	 * The one composition — sidebar + main, with every region overridable: pass a component to
	 * REPLACE a region, `false`/`null` to REMOVE it, nothing for the default. Written ONLY in public
	 * API (the eject litmus: copy this file into your app and it still runs). Sets the shell context
	 * so bricks inside find the site without prop threading.
	 *
	 * ```svelte
	 * <Frame {site}>{@render children()}</Frame>
	 * <Frame {site} sidebar={MySidebar} footer={null}>…</Shell>
	 * ```
	 */
	import type { Component, Snippet } from 'svelte';
	import { page } from '$app/state';
	import { set_shell_context } from '../context.js';
	import { mountBase, type Site } from '../site.js';
	import Sidebar from './Sidebar.svelte';

	type Region = Component<{ site: Site }> | false | null | undefined;

	let {
		site,
		base,
		header,
		sidebar,
		footer,
		children
	}: {
		site: Site;
		/** Mount prefix override. Default: derived by subtraction from the current page (catch-all). */
		base?: string;
		/** Top region — no default; provide a component to have one. */
		header?: Region;
		/** Side region — defaults to the `Sidebar` brick; component replaces, `false`/`null` removes. */
		sidebar?: Region;
		/** Bottom region — no default. */
		footer?: Region;
		children: Snippet;
	} = $props();

	// Deliberate init-time snapshot: context is set once per mount (csr=false SSR) — wiring, not state.
	// svelte-ignore state_referenced_locally
	const the_base = base ?? mountBase(page.url, page.params.slug ?? '');
	// svelte-ignore state_referenced_locally
	set_shell_context({ site, base: the_base, components: site.components });
</script>

<div class="og-shell">
	<!-- First focusable element: a keyboard user can jump the nav straight to the content. Visually
	     hidden until focused (see `.og-skip`). Targets the `<main>` landmark below. -->
	<a class="og-skip" href="#og-main">Skip to content</a>
	{#if header}
		{@const H = header}
		<header class="og-header"><H {site} /></header>
	{/if}
	<div class="og-frame">
		{#if sidebar !== false && sidebar !== null}
			<aside class="og-side">
				{#if sidebar}
					{@const S = sidebar}
					<S {site} />
				{:else}
					<Sidebar />
				{/if}
			</aside>
		{/if}
		<main class="og-main" id="og-main" tabindex="-1">{@render children()}</main>
	</div>
	{#if footer}
		{@const F = footer}
		<footer class="og-footer"><F {site} /></footer>
	{/if}
</div>
