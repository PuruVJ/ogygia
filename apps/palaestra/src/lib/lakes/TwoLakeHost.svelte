<script lang="ts">
	// REGRESSION: two lakes of the SAME component (same `wake:'none'` → same entry id) directly inside
	// ONE island. lift/restore must pair each lake with its OWN lifted content by POSITION — a shared
	// entry id must not send both frags to the first box (leaving the second empty).
	import FrozenBox from './FrozenBox.svelte' with { wake: 'none' };
	let count = $state(0);
</script>

<div class="island" data-two-lake-host>
	<button data-tlh-btn onclick={() => (count += 1)}>island count: {count}</button>
	<div data-tlh-first><FrozenBox label="alpha-lake" /></div>
	<div data-tlh-second><FrozenBox label="beta-lake" /></div>
</div>
