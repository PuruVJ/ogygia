<script lang="ts">
	// THE CACHE CHECK's page (internal/bench/cache-bust-check.mjs): islands whose code changes between
	// two builds (Probe, ProbeTwin: a shared version module) next to one that does not (Steady), and a
	// hole whose answer carries an island (HoleProbe → HoleInner).
	import Probe from '$lib/dtcache/Probe.svelte' with { wake: 'load' };
	import ProbeTwin from '$lib/dtcache/ProbeTwin.svelte' with { wake: 'load' };
	import Steady from '$lib/dtcache/Steady.svelte' with { wake: 'load' };
	import HoleProbe from '$lib/dtcache/HoleProbe.svelte' with { render: 'deferred' };
</script>

<h1>cache lab</h1>
<Probe label="probe" />
<ProbeTwin />
<Steady />
<HoleProbe>
	{#snippet ogygiaFallback()}<p data-hole-fallback>loading…</p>{/snippet}
</HoleProbe>
