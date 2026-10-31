<script lang="ts">
	// Per-row cost that looks innocent in review but adds up across thousands of rows: a fresh
	// Intl formatter per row, date formatting, and string churn. Attributed to `HeavyRow`.
	let { i, seed }: { i: number; seed: number } = $props();

	const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
	const pct = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2 });
	const when = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	const value = ((seed * (i + 1) * 2654435761) % 1_000_000) / 100;
	const change = (((seed + i) % 2000) - 1000) / 10000;
	const ts = when.format(new Date(1_600_000_000_000 + i * 86_400_000));
	const label = `SKU-${(seed ^ i).toString(16).padStart(6, '0').toUpperCase()}`;
	const tags = Array.from({ length: 6 }, (_, k) => `t${(i + k) % 40}`).join(' ');
</script>

<tr class="hr">
	<td class="hr-i">{i}</td>
	<td class="hr-l">{label}</td>
	<td class="hr-m">{money.format(value)}</td>
	<td class="hr-c" class:down={change < 0}>{pct.format(change)}</td>
	<td class="hr-t">{ts}</td>
	<td class="hr-g">{tags}</td>
</tr>

<style>
	.hr td {
		padding: 2px 8px;
		font-size: 0.8rem;
		border-bottom: 1px solid #eee;
		font-variant-numeric: tabular-nums;
	}
	.hr-c.down {
		color: #c0392b;
	}
</style>
