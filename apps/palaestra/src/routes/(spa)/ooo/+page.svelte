<script lang="ts">
	// OUT-OF-ORDER streaming proof. Three deferred regions with staggered server delays (SECONDS),
	// declared A(3s) → B(1s) → C(2s). Navigate here (SPA) and watch the batch POST: its <template>
	// frames arrive in SETTLE order — B, then C, then A — not declaration order.
	import Slow from '$lib/SlowGreeting.svelte' with { render: 'deferred' };
</script>

<h1 data-static-shell>Out-of-order streaming</h1>
<p data-static-shell>
	Navigate here from another page (click a nav link), then watch the boxes fill: B (1s) first, then
	C (2s), then A (3s) — out of declaration order. The batch flushes each frame as it settles.
</p>

<section data-ooo="a"><Slow s={3} label="A · declared 1st · 3s">{#snippet ogygiaFallback()}<p data-fallback="a">A loading (3s)…</p>{/snippet}</Slow></section>
<section data-ooo="b"><Slow s={1} label="B · declared 2nd · 1s">{#snippet ogygiaFallback()}<p data-fallback="b">B loading (1s)…</p>{/snippet}</Slow></section>
<section data-ooo="c"><Slow s={2} label="C · declared 3rd · 2s">{#snippet ogygiaFallback()}<p data-fallback="c">C loading (2s)…</p>{/snippet}</Slow></section>
