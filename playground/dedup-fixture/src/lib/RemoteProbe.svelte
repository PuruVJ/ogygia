<script>
	// Exercises the standalone `.remote` stub + client resolution for query.batch + prerender.
	import { getSquare, getManifesto } from '$lib/x.remote';
	const s = getSquare(3);
	const m = getManifesto();
	const MARK = 'standalone-remote-probe-marker';
</script>
<p data-x title={MARK}>{s.current} {m.current}</p>
