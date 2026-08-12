<script lang="ts">
	let { start = 0 } = $props();
	let n = $state(start);
</script>
<button data-counter onclick={() => n++}>count {n}</button>
