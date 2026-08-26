<script lang="ts">
	/**
	 * The profiler UI shell: owns the shared stylesheet (the sibling profiler.css, imported below) and
	 * renders the footer. Every profiler view wraps its body in this. Component-specific styles live
	 * scoped in their own components (Treemap / Flame / Waterfall / ReportBody / ShareLink /
	 * PermalinkGate); the shared vocabulary is the imported sheet.
	 *
	 * Reaching a routeless, server-only-rendered page: the profiler renders through `ogygia/router` +
	 * `document()`, so its component CSS is emitted + linked by the SERVER-ROUTER CSS mechanism
	 * (link/router-css.ts) — Shell is a transitive child of every page component, so this sheet ships on
	 * every profiler page.
	 *
	 * NOTE — no literal style/script tag or a preprocessor-dialect block may appear anywhere in this
	 * file, comments included: this ships raw and svelte2tsx (type-gen) treats such a token as a real
	 * open tag and reports "script left open". See test/profiler-ui-consumer-safe.
	 */
	import type { Snippet } from 'svelte';
	// The shared profiler vocabulary (reset, typography, tables, buttons, form controls…). Global by
	// nature — every page composes with it — so it lives in a sibling stylesheet, not scoped here. It's
	// collected onto every page's server-router CSS aggregate because Shell is a child of every page.
	import './profiler.css';
	let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
	<!-- Tell the ogygia devtools to stay out of profiler pages (incl. the Profiler tab's embedded iframe). -->
	<meta name="ogygia-devtools" content="off" />
</svelte:head>

{@render children()}

<div class="footer">
	ogygia/profiler — samples the whole Node process during SSR. <b>Self</b> = time (or memory) inside the
	function itself. <b>Total</b> = self plus everything it called. <b>Per call</b> = total ÷ how many times
	it ran (a ×N tag means it ran N times; no tag means once).
</div>

<style>
	/* The shell's own chrome (scoped). The shared vocabulary lives in ./profiler.css. */
	.footer {
		margin-top: 40px;
		padding-top: 12px;
		border-top: 1px solid #1e232b;
		color: #7d8590;
		font-size: 12px;
	}
</style>
