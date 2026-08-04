<script>
	// Receives page params/data captured on the island usage, where the host's
	// `import { page } from '$app/state'` is copied into the island virtual module
	// and reliably aliased to the client shim.
	let { id, order } = $props();
</script>

<div class="island" data-orderdetail>
	<h2>Order #{id} <small>(id + data via page shim)</small></h2>
	<div data-customer>Customer: {order.customer}</div>
	<div data-total>Total: {order.total}</div>
	<div data-status>Status: {order.status}</div>
	<div data-created>Created: {order.createdAt.toISOString()}</div>
	<div data-lineitems>Line items (Map): {order.lineItems.size}</div>
	<div data-city>Ships to: {order.shipping.address.city}, {order.shipping.address.country}</div>
</div>
