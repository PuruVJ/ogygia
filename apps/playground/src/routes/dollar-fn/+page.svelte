<script>
	// og.$ fixture: a csr=false host marks a closure; the island receives a LIVE bound
	// function through context — the fn kind's whole pipeline (hoist → manifest → rebind).
	import { setContext } from 'ogygia';
	import DollarIsland from '$lib/DollarIsland.svelte' with { wake: 'load' };

	const tax = 0.19; // local capture — becomes a bound param of the hoisted factory
	setContext('fmt', import.meta.og.$((n) => 'x' + (n * (1 + tax)).toFixed(2)));
</script>

<h1>og.$ — a function crosses the boundary</h1>
<DollarIsland />
