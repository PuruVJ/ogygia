<script lang="ts">
	// /dt-timers: see +page.server.ts (timers a render leaves running).
	let { data } = $props();
</script>

<h1>server timers lab</h1>
<p>polls so far: {data.polls}</p>
