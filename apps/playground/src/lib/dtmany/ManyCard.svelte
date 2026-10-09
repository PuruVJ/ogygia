<script lang="ts">
	// A static card rendered as a lake: markup only, no code in the browser.
	let { n }: { n: number } = $props();
</script>

<p class="card">card {n}: plain server markup</p>
