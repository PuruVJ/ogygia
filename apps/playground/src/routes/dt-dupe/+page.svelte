<script lang="ts">
	// The profiler's duplicate-module plant (internal/bench/profiler-browser-key.mjs): two islands import
	// one module by two paths (a package's src and its dist), so the page loads it twice.
	import DupSearch from '$lib/dtlab/DupSearch.svelte' with { wake: 'load' };
	import DupPick from '$lib/dtlab/DupPick.svelte' with { wake: 'load' };
</script>

<h1>one module, two copies</h1>
<DupSearch />
<DupPick />
