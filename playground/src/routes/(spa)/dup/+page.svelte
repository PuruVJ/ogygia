<script lang="ts">
	// The SAME component imported twice with DIFFERENT hydrate strategies. Each usage becomes its own
	// island virtual module, and both modules import DupWidget.svelte — Rolldown must emit DupWidget's
	// code in exactly ONE shared client chunk (asserted by verify/dedup.ts), never duplicated per island.
	import DupWidget from '$lib/DupWidget.svelte' with { hydrate: 'load' };
	import DupWidgetLazy from '$lib/DupWidget.svelte' with { hydrate: 'visible' };
</script>

<h1 data-static-shell>Duplicate-import dedup</h1>
<p data-static-shell>The same component, two strategies — its code should ship in one chunk.</p>

<DupWidget start={1} />

<div style="height: 1200px" data-static-shell aria-hidden="true"></div>

<DupWidgetLazy start={100} />
