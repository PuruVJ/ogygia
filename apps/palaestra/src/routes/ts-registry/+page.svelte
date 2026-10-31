<script lang="ts">
	// Consume the `.ts` registry three ways — all placed the way Builder's SDK places a
	// `customComponents` entry (by reference, via `<svelte:component>`), plus the raw one via `region()`:
	//   - `Widget`  = a `with { wake }` mountable binding (default import).
	//   - `Ticker`  = an `asRegion(...)` mountable binding of a NAMED barrel import.
	//   - `rawDescriptor` = a `region: 'raw'` held descriptor → rendered through `region()` + `<Region>`.
	import type { Component } from 'svelte';
	import { Region, region } from 'ogygia';
	import { registry } from '$lib/ts-registry';

	const Widget = registry[0].component as Component<Record<string, unknown>>;
	const rawDescriptor = registry[1].component as Component<Record<string, unknown>>;
	const AsRegionTicker = registry[2].component as Component<Record<string, unknown>>;
</script>

<h1 data-static-shell>.ts registry — wake import, raw region, and asRegion of a named barrel import</h1>

<!-- held raw region, given a wake schedule at the call → hydrates on load -->
<Region of={region(rawDescriptor, { start: 3, label: 'Ts registry raw' }, () => ({ wake: 'load' }))} />

<!-- spacer so the wake:'visible' bindings gate on scroll, not first paint -->
<div style="height: 140vh" data-spacer></div>

<!-- a `with { wake }` mountable binding, PLACED by reference like Builder's SDK does -->
<svelte:component this={Widget} start={7} label="Ts registry widget" />

<!-- an asRegion() mountable binding of a NAMED barrel import, placed the same way -->
<svelte:component this={AsRegionTicker} start={10} label="Ts registry asRegion ticker" />
