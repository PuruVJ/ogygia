<script lang="ts">
	import type { Snippet } from 'svelte';
	// A server island (the PPR "hole"). It renders on the server per request, so its timestamp
	// changes every request — proving the hole stays FRESH even when the shell is replayed from
	// cache. `nowMs()` is stamped at render time (server-side).
	// `ogygiaFallback` is placeholder chrome rendered by the deferred-island wrapper (not here) — it
	// is declared only so a `<PprHole>{#snippet ogygiaFallback()}…{/snippet}</PprHole>` call-site types.
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();
	function nowMs() {
		// Date.now() is banned in some contexts; new Date() is fine on the server render path.
		return new Date().getTime();
	}
	const rendered_at = nowMs();
</script>

<div class="island" data-ppr-hole>
	hole rendered at <strong data-hole-time>{rendered_at}</strong>
</div>
