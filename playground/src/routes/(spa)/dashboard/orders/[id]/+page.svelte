<script lang="ts">
	import { page } from '$app/state';
	import OrderDetail from '$lib/OrderDetail.svelte' with { hydrate: 'load' };
	import PageDataProbe from '$lib/PageDataProbe.svelte' with { hydrate: 'load' };
	let { data } = $props();
</script>

<!-- page.params + page.data read on the island usage -> `page` import is copied into
     the island virtual module -> aliased to the $app/state client shim (seeded per-page). -->
<OrderDetail id={page.params.id} order={page.data.order} />

<!-- $derived over values sourced from the reactive $app/state shim; recomputes on remount. -->
<PageDataProbe id={page.params.id} customer={page.data.order.customer} />

<nav data-order-nav>
	{#if data.prevId}<a href="/dashboard/orders/{data.prevId}">← order #{data.prevId}</a>{/if}
	{#if data.nextId}<a href="/dashboard/orders/{data.nextId}">order #{data.nextId} →</a>{/if}
	<a href="/dashboard/orders">back to list</a>
</nav>
