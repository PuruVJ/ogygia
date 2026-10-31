<script lang="ts">
	// /dt-restore: a host the transform renders in scoped form (`demo-card`), inside an island. The
	// page defines `demo-card` in a BLOCKING head script, so it upgrades the moment it is parsed —
	// before ogygia's restorer reaches it. The devtools must name it (restore-late) and this island.
	// The `demo-link` below is the decoy: nothing defines it early, so its restore goes through.
	let n = $state(0);
</script>

<demo-card class="late"><button data-late-btn onclick={() => n++}>late card {n}</button></demo-card>
<a href="/dt-restore#ok" data-ok-link><demo-link>fine link</demo-link></a>
