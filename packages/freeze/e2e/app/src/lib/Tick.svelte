<script lang="ts">
	// A minimal island so the stream page has a region — the real (bcms) shape: island-ful
	// pages record the page snapshot, which is what the streamed-load disqualifier reads.
	let n = $state(0);
</script>

<button data-tick onclick={() => n++}>tick {n}</button>
