<script lang="ts">
	// PRELOADS NOTHING USES, for the devtools answer key. The plants: right.png preloaded and never
	// shown, orphan.woff2 preloaded and named by no @font-face. The decoys, each used: flat.png by an
	// <img>, big.png?bg by a CSS background, used.woff2 by an @font-face. Only the plants are named.
	const head = `<link rel="preload" as="image" href="/dt-img/right.png" />
<link rel="preload" as="image" href="/dt-img/flat.png" />
<link rel="preload" as="image" href="/dt-img/big.png?bg" />
<link rel="preload" as="font" type="font/woff2" href="/dt-font/orphan.woff2" crossorigin />
<link rel="preload" as="font" type="font/woff2" href="/dt-font/used.woff2" crossorigin />
<style>
@font-face { font-family: 'UsedFace'; src: url('/dt-font/used.woff2') format('woff2'); font-display: swap; }
.bg { width: 200px; height: 100px; background-image: url('/dt-img/big.png?bg'); background-size: cover; }
</style>`;
</script>

<svelte:head>{@html head}</svelte:head>

<h1 style="font-family: 'UsedFace', sans-serif">preload lab: used and never used</h1>
<img src="/dt-img/flat.png" width="300" height="200" alt="decoy: preloaded and shown" />
<div class="bg"></div>
