<script lang="ts">
	let n = $state(0);
</script>

<button data-stream-island onclick={() => n++}>late island: {n}</button>
