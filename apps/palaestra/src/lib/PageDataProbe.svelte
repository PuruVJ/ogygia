<script lang="ts">
	// Proves the $state-backed `$app/state` shim end-to-end: the island BOUNDARY reads the
	// reactive `page` (aliased to the shim) for `page.params.id` + `page.data.order.customer`
	// and passes them in; this `$derived` recomputes them. On an SPA nav to a different order
	// id the island remounts and the derived value reflects the fresh page — no stale snapshot.
	let { id, customer } = $props();
	const summary = $derived(`#${id} for ${customer}`);
</script>

<div class="island" data-pagedata-probe>Derived from page: {summary}</div>
