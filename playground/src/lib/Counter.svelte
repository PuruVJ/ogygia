<script>
	let { start = 0, label = 'Counter' } = $props();
	let count = $state(start);
</script>

<div class="island" data-counter>
	<strong>{label}</strong>:
	<button onclick={() => (count += 1)}>count is {count}</button>
</div>
