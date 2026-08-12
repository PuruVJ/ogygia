<script lang="ts">
	import type { Fallback } from 'ogygia';
	// A deferred server island with a deliberate delay, so the "fetching…" fallback is on screen long
	// enough to SEE before the server HTML swaps in. Rendered per fetch → the timestamp is fresh on
	// every reload. Server-only: no client JS ships for this component. `Fallback<{}>` declares the
	// reserved `ogygiaFallback` slot so svelte-check accepts the fallback snippet at the call site;
	// the compiler consumes that snippet, this component never receives it.
	let {}: Fallback = $props();
	await new Promise((r) => setTimeout(r, 650));
	const at = new Date().toLocaleTimeString();
</script>

<div class="dh dh--ready" data-deferred-hole>
	<span class="dh-k">server HTML · rendered on fetch</span>
	<strong class="dh-t">{at}</strong>
</div>

<style>
	.dh {
		display: grid;
		gap: 0.35rem;
		padding: 1rem 1.1rem;
		border-radius: 12px;
		border: 1px solid var(--line-strong, #2a2a2a);
	}
	.dh--ready {
		border-color: color-mix(in srgb, var(--accent, #4ade80) 55%, transparent);
		background: color-mix(in srgb, var(--accent, #4ade80) 10%, transparent);
	}
	.dh-k {
		font: 600 0.6875rem/1 var(--font-mono, monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.7;
	}
	.dh-t {
		font: 600 1.5rem/1 var(--font-mono, monospace);
		font-variant-numeric: tabular-nums;
	}
</style>
