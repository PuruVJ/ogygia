<script lang="ts">
	// Below the fold, wake at load: its code is in at once, and it waits for its turn while the
	// first-screen island above still loads (the scheduler's viewport-first hold). That wait is the
	// page's, not ogygia's: the devtools must not call it "ogygia's scheduler held it".
	let n = $state(0);
</script>

<button data-held="below" onclick={() => n++}>below {n}</button>
