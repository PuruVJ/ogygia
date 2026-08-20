<script lang="ts">
	// Consume the `.ts` registry two ways from ONE file:
	//   - the `wake:` binding is MOUNTABLE → place it by reference via `<svelte:component>`, exactly the
	//     way Builder's SDK renders a `customComponents` entry. Renders the island shell, wakes on scroll.
	//   - the `region: 'raw'` binding is a held descriptor → render it through ogygia's `region()` +
	//     `<Region>`, given a schedule at the call.
	import type { Component } from 'svelte';
	import { Region, region } from 'ogygia';
	import { registry } from '$lib/ts-registry';

	const Widget = registry[0].component as Component<Record<string, unknown>>;
	const rawDescriptor = registry[1].component as Component<Record<string, unknown>>;
</script>

<h1 data-static-shell>.ts registry — mixed: mountable wake (svelte:component) + held raw (region())</h1>

<!-- held raw region, given a wake schedule at the call → hydrates on load -->
<Region of={region(rawDescriptor, { start: 3, label: 'Ts registry raw' }, () => ({ wake: 'load' }))} />

<!-- spacer so the wake:'visible' binding gates on scroll, not first paint -->
<div style="height: 140vh" data-spacer></div>

<!-- mountable wake binding, PLACED by reference like Builder's SDK does -->
<svelte:component this={Widget} start={7} label="Ts registry widget" />
