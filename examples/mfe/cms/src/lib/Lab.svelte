<script lang="ts">
	// ONE component, TWO lives (the boss's csr=true|false test): imported plain = pure server
	// HTML, this button is INERT (zero JS ships). Imported `with { wake: 'load' }` = the whole
	// page is an island, this same button is ALIVE. Same load, same markup, same SEO — the only
	// delta is hydration, which is exactly what the experiment measures.
	let { data }: { data: { mode: string; stamp: string } } = $props();
	let clicks = $state(0);
</script>

<section class="lab" data-testid="lab" data-og-exp={data.stamp}>
	<h2>Hydration lab</h2>
	<p>
		You are in the <strong data-testid="lab-mode">{data.mode}</strong> arm.
	</p>
	<button data-testid="lab-btn" onclick={() => clicks++}>
		clicked {clicks} times
	</button>
	<p class="hint">
		In the <code>static</code> arm this button is server HTML with no JS — clicking does
		nothing. In the <code>hydrated</code> arm the page woke as one island and it counts.
	</p>
</section>

<style>
	.lab {
		border: 2px solid #ca8a04;
		border-radius: 10px;
		padding: 1rem;
	}
	button {
		background: #ca8a04;
		color: white;
		border: 0;
		border-radius: 6px;
		padding: 0.5rem 1rem;
		cursor: pointer;
	}
	.hint {
		color: #6b7280;
		font-size: 0.85rem;
	}
</style>
