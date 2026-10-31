<script lang="ts">
	// PLANTED markup-changed: the text depends on where it renders, so hydration rewrites it.
	const where = typeof window === 'undefined' ? 'server' : 'browser';
</script>

<p data-dt="clock">rendered on the {where}</p>
