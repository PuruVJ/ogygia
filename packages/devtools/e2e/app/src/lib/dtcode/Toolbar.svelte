<script lang="ts">
	// The island: two names from the barrel, so the whole barrel (and all it re-exports) comes along.
	import { Icons, Chip } from './index';
	let count = $state(0);
</script>

<button onclick={() => (count += 1)}><Icons name="icon-3" /><Chip label="tools {count}" /></button>
