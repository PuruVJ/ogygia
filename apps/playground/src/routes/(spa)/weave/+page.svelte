<script lang="ts">
	// ROUTE WEAVING target: four DISTINCT deferred regions, each with a staggered server delay. On SPA
	// navigation they are pulled in ONE batch stream (no per-region GET waterfall) — and because the
	// delays differ, you can watch them fill out of declaration order as each frame settles.
	import Slow from '$lib/SlowGreeting.svelte' with { render: 'deferred' };
</script>

<h1 data-static-shell>Route weaving</h1>
<p data-static-shell>
	Four server islands, woven into one batch stream on navigation. No waterfall — and staggered so you
	can watch them stream in: Bravo (1s), Delta (1.5s), Alpha (2s), Charlie (3s).
</p>

<section data-weave="a"><Slow s={2} label="Alpha · 2s">{#snippet ogygiaFallback()}<p data-fallback="a">loading a…</p>{/snippet}</Slow></section>
<section data-weave="b"><Slow s={1} label="Bravo · 1s">{#snippet ogygiaFallback()}<p data-fallback="b">loading b…</p>{/snippet}</Slow></section>
<section data-weave="c"><Slow s={3} label="Charlie · 3s">{#snippet ogygiaFallback()}<p data-fallback="c">loading c…</p>{/snippet}</Slow></section>
<section data-weave="d"><Slow s={1.5} label="Delta · 1.5s">{#snippet ogygiaFallback()}<p data-fallback="d">loading d…</p>{/snippet}</Slow></section>
