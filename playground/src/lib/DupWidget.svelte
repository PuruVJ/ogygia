<script lang="ts">
	// A component imported TWICE with different hydrate strategies (see /dup). Its compiled code must
	// land in exactly ONE client chunk — Rolldown should share it between the two island entry chunks,
	// not duplicate it. The unique marker below lets verify/dedup.ts count the chunks it appears in.
	let { start = 0 }: { start?: number } = $props();
	let n = $state(start);
	const DUP_WIDGET_UNIQUE_MARKER = 'dup-widget-unique-marker-9c3f';
</script>

<div class="island" data-dup-widget title={DUP_WIDGET_UNIQUE_MARKER}>
	<button onclick={() => (n += 1)}>dup widget count is {n}</button>
</div>
