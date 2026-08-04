<script lang="ts">
	import FilterBar from '$lib/FilterBar.svelte' with { hydrate: 'load' };
	import DataTable from '$lib/DataTable.svelte' with { hydrate: 'load' };
	let { data } = $props();
</script>

<h1 data-static-shell>Orders — {data.total} total</h1>

<!-- island that navigates via goto() to change ?status= -->
<FilterBar />

<p data-orders-meta>
	page {data.page}/{data.pages} · sort {data.sort} {data.dir} · status {data.status}
</p>

<!-- server-rendered shell table (NOT an island); row links drive SPA nav -->
<table data-shell-table>
	<thead><tr><th>ID</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead>
	<tbody>
		{#each data.rows as o}
			<tr>
				<td><a href="/dashboard/orders/{o.id}">#{o.id}</a></td>
				<td>{o.customer}</td>
				<td>{o.status}</td>
				<td>{o.total}</td>
			</tr>
		{/each}
	</tbody>
</table>

<!-- pagination as plain links; the SPA router intercepts them -->
<nav data-pagination>
	{#if data.page > 1}
		<a href="?status={data.status}&sort={data.sort}&dir={data.dir}&page={data.page - 1}">← prev</a>
	{/if}
	{#if data.page < data.pages}
		<a href="?status={data.status}&sort={data.sort}&dir={data.dir}&page={data.page + 1}">next →</a>
	{/if}
</nav>

<!-- client-side sortable table island over the same server rows (rows captured as a prop) -->
<DataTable rows={data.rows} />
