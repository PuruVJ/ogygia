<script lang="ts">
	// STATIC live-partial component (`partial: 'static'`) — ships NO client JS. The server renders
	// it fresh each tick and the runtime MORPHS the new HTML into the existing DOM in place, so the
	// text updates without the element being rebuilt (see verify/live-partial.ts: the node identity
	// and any focused input survive the morph).
	let { value, at }: { value: number; at: string } = $props();
</script>

<div class="island" data-stat-badge>
	<strong data-badge-value>{value}</strong>
	<small data-badge-at>{at}</small>
</div>
