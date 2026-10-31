<script lang="ts">
	// A FONT PRELOAD SAFARI DOWNLOADS AGAIN, for the devtools answer key. Both fonts are preloaded and
	// answered with Vary: Origin (the dev server's habit). The plant: late.woff2, whose @font-face
	// comes in a stylesheet a script adds after the page parsed — Safari fetches it again. The decoy:
	// early.woff2, named in the HTML's own stylesheet — reused. Only the plant is named, with why.
	const head = `<link rel="preload" as="font" type="font/woff2" href="/dt-font/late.woff2" crossorigin />
<link rel="preload" as="font" type="font/woff2" href="/dt-font/early.woff2" crossorigin />
<style>@font-face { font-family: 'EarlyFace'; src: url('/dt-font/early.woff2') format('woff2'); font-display: swap; }</style>
<script>setTimeout(function () { var s = document.createElement('style'); s.textContent = "@font-face { font-family: 'LateFace'; src: url('/dt-font/late.woff2') format('woff2'); font-display: swap; }"; document.head.appendChild(s); }, 2000);<\/script>`;
	// (2 s: after the preload's answer is in — the font host takes 1.5 s; a rule that comes while the
	// preload is still loading joins it, even in Safari)
</script>

<svelte:head>{@html head}</svelte:head>

<h1 style="font-family: 'LateFace', sans-serif">font lab: a @font-face that came late</h1>
<p style="font-family: 'EarlyFace', serif">This face is named in the page's own stylesheet.</p>
