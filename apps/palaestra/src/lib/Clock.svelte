<script lang="ts">
	let time = $state(new Date().toLocaleTimeString());
	$effect(() => {
		const id = setInterval(() => {
			time = new Date().toLocaleTimeString();
		}, 1000);
		return () => clearInterval(id);
	});
</script>

<div class="island" data-clock-island>
	Clock island: <strong>{time}</strong>
</div>
