<script lang="ts">
	// A tiny interactive island — proof that a live Svelte component can sit inside prose and hydrate
	// on its own (here on `wake: 'visible'`). Everything around it stays static server-rendered HTML.
	let count = $state(0);
</script>

<!-- A `<span>` (not a `<div>`): this island is authored INLINE inside a markdown sentence, so it
	lands inside a `<p>`. A block element there is invalid HTML — the browser parser hoists it out of
	the paragraph before hydration, leaving the region empty and mounting a duplicate. A phrasing-level
	`<span>` (styled `display: inline-flex`) is valid inline content and parses in place. -->
<span class="demo-counter">
	<button type="button" onclick={() => count--} aria-label="Decrement">−</button>
	<output>{count}</output>
	<button type="button" onclick={() => count++} aria-label="Increment">+</button>
</span>

<style>
	.demo-counter {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem;
		border: 1px solid var(--og-line, #e4e4e8);
		border-radius: 12px;
		background: var(--og-bg-subtle, #f7f7f8);
	}
	button {
		width: 2.2rem;
		height: 2.2rem;
		border: 1px solid var(--og-line, #e4e4e8);
		border-radius: 9px;
		background: var(--og-thumb, #fff);
		color: var(--og-text, #1c1c21);
		font-size: 1.1rem;
		font-weight: 600;
		cursor: pointer;
		transition: transform 120ms ease, background 120ms ease;
	}
	button:hover {
		background: var(--og-accent, #0d9488);
		color: #fff;
		border-color: transparent;
	}
	button:active {
		transform: scale(0.92);
	}
	output {
		min-width: 3rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
		font-size: 1.35rem;
		font-weight: 700;
		color: var(--og-text, #1c1c21);
	}
</style>
