<script lang="ts">
	import '$lib/styles/feel.css';

	let waves = $state(0);
	let at = $state('—');

	$effect(() => {
		at = new Date().toLocaleTimeString();
	});
</script>

<div class="feel">
	<p class="feel-status">In view · {at}</p>
	<button type="button" class="feel-btn" onclick={() => (waves += 1)}>Wave · {waves}</button>
</div>
