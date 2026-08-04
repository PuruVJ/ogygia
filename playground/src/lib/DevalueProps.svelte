<script>
	let { date, map, set, big, nested } = $props();
	let ok = $state(false);
</script>

<div class="island" data-devalue>
	<div data-date>date instanceof Date: {String(date instanceof Date)} — {date.toISOString()}</div>
	<div data-map>map instanceof Map: {String(map instanceof Map)} — size {map.size}, a={map.get('a')}</div>
	<div data-set>set instanceof Set: {String(set instanceof Set)} — has(2)={String(set.has(2))}</div>
	<div data-big>bigint: {big} (typeof {typeof big})</div>
	<div data-nested>nested.deep.value: {nested.deep.value}</div>
	<button onclick={() => (ok = true)}>revived? {String(ok)}</button>
</div>
