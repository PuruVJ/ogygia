<script>
	// Island navigating via goto() from `sk-islands/app` (reliable from any island
	// component). Reads the current status from location (client-only handler).
	import { goto } from 'sk-islands/app';

	const statuses = ['all', 'pending', 'shipped', 'delivered', 'cancelled'];
	let current = $state(
		typeof location !== 'undefined'
			? new URLSearchParams(location.search).get('status') || 'all'
			: 'all'
	);

	function setStatus(s) {
		const u = new URL(location.href);
		if (s === 'all') u.searchParams.delete('status');
		else u.searchParams.set('status', s);
		u.searchParams.delete('page');
		current = s;
		goto(u.pathname + u.search); // -> sk-islands SPA router
	}
</script>

<div class="island" data-filterbar>
	<strong>filter (island goto):</strong>
	{#each statuses as s}
		<button data-status={s} aria-pressed={current === s} onclick={() => setStatus(s)}>{s}</button>
	{/each}
</div>
