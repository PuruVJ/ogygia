<script lang="ts">
	// THE LOAD SCHEDULER (e2e/load-scheduler.spec.ts): the hero below is the page's critical resource
	// (`fetchpriority="high"`); the test holds it. Island code must wait for it — or for the visitor's
	// first input, or the cap — while an `interaction` island still wakes at once.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import VisibleCounter from '$lib/Counter.svelte' with { wake: 'visible' };
	import IdleCounter from '$lib/Counter.svelte' with { wake: 'idle' };
	import InteractionCounter from '$lib/InteractionCounter.svelte' with { wake: 'interaction' };
</script>

<svelte:head>
	<!-- a hero preload per breakpoint, none matching: the browser fetches none, nothing may wait on them -->
	<link rel="preload" as="image" fetchpriority="high" media="(max-width: 1px)" href="/load-scheduler-hero-tiny.png" />
	<link rel="preload" as="image" fetchpriority="high" media="(min-width: 99999px)" href="/load-scheduler-hero-huge.png" />
</svelte:head>

<h1>Load scheduler</h1>

<img data-hero src="/load-scheduler-hero.png" fetchpriority="high" width="320" height="120" alt="" />

<div data-ls-load><Counter label="load" /></div>
<div data-ls-visible><VisibleCounter label="visible" /></div>
<div data-ls-idle><IdleCounter label="idle" /></div>

<InteractionCounter />
