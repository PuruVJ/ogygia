<script lang="ts">
	// PLANTED queue: five of these on one page, each awaiting 0.9 s of "data". A server process
	// renders four holes at a time and a render holds its slot through its awaits, so the fifth
	// waits for a slot: its fallback holds the first screen about twice as long. The devtools must
	// name it and say it waited for a render slot on the server; the first four never.
	let { n }: { n: number } = $props();
	await new Promise((ok) => setTimeout(ok, 900));
</script>

<p data-hole-answer="queue-{n}">queued hole {n}: answered</p>
