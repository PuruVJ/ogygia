<script lang="ts">
	// A deliberately EXPENSIVE island: ~6 ms of synchronous work at init, in the browser only — the
	// cost a real component's hydrate carries (a header with 300 KB of props measured at 146 ms).
	// Twenty-one of these in one task is a 126 ms long task; one per task is twenty-one short ones.
	let { n = 0 }: { n?: number } = $props();
	if (typeof document !== 'undefined') {
		const t0 = performance.now();
		while (performance.now() - t0 < 6) {
			/* spin */
		}
	}
</script>

<p data-heavy={n}>heavy {n}</p>
