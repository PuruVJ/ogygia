<script lang="ts">
	// INTERACTIONS for the devtools answer key. Two plants, one per run: SlowSave's click is slow in its
	// own handler; a click on QuickCount just after BusyTimer's waits behind BusyTimer's timer. The
	// devtools must name the island clicked, the phase that cost the time, and (for the wait) the
	// timer's island; QuickCount clicked alone is never slow.
	import SlowSave from '$lib/dtinp/SlowSave.svelte' with { wake: 'load' };
	import QuickCount from '$lib/dtinp/QuickCount.svelte' with { wake: 'load' };
	import BusyTimer from '$lib/dtinp/BusyTimer.svelte' with { wake: 'load' };
</script>

<h1>interaction lab</h1>
<SlowSave />
<QuickCount />
<BusyTimer />
