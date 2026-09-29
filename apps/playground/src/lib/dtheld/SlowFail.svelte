<script module>
	// PLANTED: this island's module takes 700 ms to arrive (a slow first compile, a slow network),
	// then it throws. While it loads, the scheduler rightly holds the ready island below the fold.
	await new Promise((ok) => setTimeout(ok, 700));
</script>

<script lang="ts">
	if (typeof window !== 'undefined') throw new Error('planted: SlowFail throws after a slow load');
</script>

<div data-held="slow-fail">slow, then broken</div>
