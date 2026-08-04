<script>
	let { item, index } = $props();
	let n = $state(0);
</script>

<div class="island" data-each-island>
	Item #{index}: <strong>{item.name}</strong> (score {item.score})
	<button onclick={() => (n += 1)}>+{n}</button>
</div>
