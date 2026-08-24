<script lang="ts">
	/**
	 * The profiler UI shell: injects the one stylesheet (via `<svelte:head>`, which `document()` lifts
	 * into `<head>`) and renders the footer. Every profiler view wraps its body in this. Styles are a
	 * raw head style element, not Svelte scoped styles — see style.ts for why.
	 */
	import type { Snippet } from 'svelte';
	import { PROFILER_STYLE } from './style.js';
	let { children }: { children: Snippet } = $props();
	// Assemble the head style element from a variable so the literal tag never appears as a substring
	// in this file. A consumer's preprocess pipeline regex-scans sources for style blocks; a literal
	// one here (even in a string or comment) gets its contents handed to postcss, which chokes on the
	// interpolation ("Unknown word PROFILER_STYLE"). See test/profiler-ui-consumer-safe.
	const T = 'style';
	const style_tag = `<${T}>${PROFILER_STYLE}</${T}>`;
</script>

<svelte:head>
	{@html style_tag}
</svelte:head>

{@render children()}

<div class="footer">
	ogygia/profiler — samples the whole Node process during SSR. <b>Self</b> = time (or memory) inside the
	function itself. <b>Total</b> = self plus everything it called. <b>Per call</b> = total ÷ how many times
	it ran (a ×N tag means it ran N times; no tag means once).
</div>
