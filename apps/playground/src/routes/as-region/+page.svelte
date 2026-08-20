<script lang="ts">
	// asRegion — mark barrel/named imports as placed islands (the macro alternative to the
	// `import X from '…' with { wake }` import-attribute form, which is default-import-only).
	//
	// `{ Ticker, Flag }` are consumed ONLY by asRegion → the transform strips this import from the host
	// (the island entries import the components themselves, straight from the barrel).
	import { Ticker, Flag } from '$lib/barrel';
	// `brandConfig` is a NON-component barrel export used normally in the shell → this import stays.
	import { brandConfig } from '$lib/barrel';

	const TickerIsland = import.meta.og.asRegion(Ticker, { wake: 'load' });
	const FlagIsland = import.meta.og.asRegion(Flag, { wake: 'visible' });
</script>

<h1 data-static-shell>asRegion — barrel islands</h1>
<p data-static-shell data-brand>Brand: {brandConfig.name}</p>

<TickerIsland start={10} label="Barrel ticker" />
<FlagIsland on={true} />
