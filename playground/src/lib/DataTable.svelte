<script lang="ts">
	// Client-side data management island: sorts server-passed rows in the browser.
	let { rows }: { rows: Record<string, any>[] } = $props();
	let sortKey = $state('id');
	let asc = $state(true);
	const sorted = $derived(
		[...rows].sort((a: Record<string, any>, b: Record<string, any>) => {
			const c = a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0;
			return asc ? c : -c;
		})
	);
	function toggle(k: string) {
		if (sortKey === k) asc = !asc;
		else {
			sortKey = k;
			asc = true;
		}
	}
</script>

<div class="island" data-datatable>
	<strong>client-sorted table</strong> (sort: {sortKey} {asc ? '↑' : '↓'})
	<table>
		<thead>
			<tr>
				<th><button data-sort="id" onclick={() => toggle('id')}>ID</button></th>
				<th><button data-sort="total" onclick={() => toggle('total')}>Total</button></th>
				<th>Customer</th>
				<th>Status</th>
			</tr>
		</thead>
		<tbody>
			{#each sorted as o (o.id)}
				<tr data-row-id={o.id}>
					<td>{o.id}</td>
					<td>{o.total}</td>
					<td>{o.customer}</td>
					<td>{o.status}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
