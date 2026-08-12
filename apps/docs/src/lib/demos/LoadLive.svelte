<script lang="ts">
	import '$lib/styles/feel.css';

	let n = $state(0);
	let readyAt = $state('—');

	$effect(() => {
		readyAt = new Date().toLocaleTimeString();
	});
</script>

<div class="feel">
	<p class="feel-status">Live since {readyAt}</p>
	<button type="button" class="feel-btn" onclick={() => (n += 1)}>Ping · {n}</button>
</div>
