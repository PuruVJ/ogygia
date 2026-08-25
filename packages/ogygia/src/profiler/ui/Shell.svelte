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
	// Request payloads ship RAW (unformatted) and are pretty-printed + syntax-highlighted lazily, the first
	// time their row is expanded — never on load. This is what makes multi-MB bodies survivable: nothing is
	// formatted until you open it, the parse/stringify runs a frame after a "formatting…" note paints (so
	// the click never blocks), and highlight.js — which chokes on huge input — is skipped above ~200 KB.
	// highlight.js loads from a CDN at RUNTIME so it never becomes an ogygia dependency. The script tags are
	// assembled from the `J` variable so the closing-tag substring never appears literally anywhere in this
	// file (comment included) — otherwise Svelte's lexer would close this block early.
	const J = 'script';
	const HL = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1';
	const hl_head =
		`<link rel="stylesheet" href="${HL}/styles/github-dark.min.css">` +
		`<${J} src="${HL}/highlight.min.js" defer></${J}>` +
		`<${J} defer>` +
		`(function(){var MAXHL=200000;` +
		`function fmt(r){try{return JSON.stringify(JSON.parse(r),null,2)}catch(e){return r}}` +
		`function format(c){if(c.dataset.ogFmt)return;c.dataset.ogFmt='1';var raw=c.textContent;` +
		`if(raw.length>100000)c.textContent='formatting '+Math.round(raw.length/1024)+' KB…';` +
		`requestAnimationFrame(function(){requestAnimationFrame(function(){var p=fmt(raw);c.textContent=p;` +
		`if(window.hljs&&p.length<=MAXHL){try{window.hljs.highlightElement(c)}catch(x){}}})})}` +
		`document.addEventListener('toggle',function(e){var d=e.target;` +
		`if(d&&d.open&&d.classList&&d.classList.contains('req')){` +
		`var c=d.querySelector('pre.payload>code');if(c)format(c)}},true)})()` +
		`</${J}>`;
</script>

<svelte:head>
	<!-- Tell the ogygia devtools to stay out of profiler pages (incl. the Profiler tab's embedded iframe). -->
	<meta name="ogygia-devtools" content="off" />
	{@html style_tag}
	{@html hl_head}
</svelte:head>

{@render children()}

<div class="footer">
	ogygia/profiler — samples the whole Node process during SSR. <b>Self</b> = time (or memory) inside the
	function itself. <b>Total</b> = self plus everything it called. <b>Per call</b> = total ÷ how many times
	it ran (a ×N tag means it ran N times; no tag means once).
</div>
