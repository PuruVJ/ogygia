<script lang="ts">
	// A CLICK THAT FORCES LAYOUT, for the devtools answer key: ThrashSort's handler reads each row's
	// height right after changing the row before it. The slow interaction must say how much of the
	// handler was the browser laying the page out again, and give the read-then-write fix.
	import ThrashSort from '$lib/dtinp/ThrashSort.svelte' with { wake: 'load' };
</script>

<h1>forced-layout click lab</h1>
<ThrashSort />
