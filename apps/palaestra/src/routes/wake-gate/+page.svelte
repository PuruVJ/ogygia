<script lang="ts">
	// THE WAKE GATE (e2e/wake-gate.spec.ts): a `load`, an in-viewport `visible` and an `idle` island
	// start no earlier than a Kit page would start hydrating — after DOMContentLoaded and one painted
	// frame. The slow module script below is held by the test, which holds DOMContentLoaded with it
	// (it fires only after every deferred script ran); the runtime has booted by then. The
	// `interaction` island must still wake at once when used inside that window.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import VisibleCounter from '$lib/Counter.svelte' with { wake: 'visible' };
	import IdleCounter from '$lib/Counter.svelte' with { wake: 'idle' };
	import InteractionCounter from '$lib/InteractionCounter.svelte' with { wake: 'interaction' };

	const SLOW_SCRIPT = '<script type="module" src="/wake-gate-slow.js"></' + 'script>';
</script>

<svelte:head>
	{@html SLOW_SCRIPT}
</svelte:head>

<h1>Wake gate</h1>

<div data-gate-load><Counter label="load" /></div>
<div data-gate-visible><VisibleCounter label="visible" /></div>
<div data-gate-idle><IdleCounter label="idle" /></div>

<InteractionCounter />
