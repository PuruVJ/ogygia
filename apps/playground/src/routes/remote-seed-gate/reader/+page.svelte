<script lang="ts">
	// The same lake, plus an island whose chunk closure imports `greetings.remote` (ResolvedGreeting
	// awaits `getGreeting` during SSR and would re-run it on hydrate). Here the seed ships — for the
	// island's call AND the lake's (same module: the island could call it) — and hydration fetches
	// nothing (the zero-flash contract, e2e/flicker.spec.ts).
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'load' };
</script>

<h1>remote seed gate — reader</h1>
<LakeGreeting />
<ResolvedGreeting name="reader" />
<p><a href="/remote-seed-gate">← without a reader island</a></p>
