<script lang="ts">
	// PLANTED slow hole: its server render waits 1.5 s (slow data), so its fallback is what the
	// visitor looks at on the first screen that long. The devtools must name it; the fast Greeting
	// next to it never.
	let { label }: { label: string } = $props();
	await new Promise((ok) => setTimeout(ok, 1500));
</script>

<p data-hole-answer="slow">{label}: answered late</p>
