<script>
	import { page } from '$app/state';
	import OrderDetail from '$lib/OrderDetail.svelte' with { island: 'load' };
	let { data } = $props();
</script>

<!-- page.params + page.data read on the island usage -> `page` import is copied into
     the island virtual module -> aliased to the $app/state client shim (seeded per-page). -->
<OrderDetail id={page.params.id} order={page.data.order} />

<nav data-order-nav>
	{#if data.prevId}<a href="/dashboard/orders/{data.prevId}">← order #{data.prevId}</a>{/if}
	{#if data.nextId}<a href="/dashboard/orders/{data.nextId}">order #{data.nextId} →</a>{/if}
	<a href="/dashboard/orders">back to list</a>
</nav>
