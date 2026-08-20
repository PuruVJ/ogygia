<script lang="ts">
	// PLAIN Svelte getContext — no ogygia handle at all. This is the interop case: an existing island
	// that reads a string-keyed context set by a <Provide> above it, across the island-root split on a
	// csr=false page. Nothing here imports from ogygia; the value is seeded into this island's context
	// at hydrate.
	import { getContext } from 'svelte';

	const greeting = getContext<string>('greeting');
	const counter = getContext<{ count: number } | undefined>('room');
</script>

<span
	class="island"
	data-plain-reader
	data-plain-greeting={greeting ?? ''}
	data-plain-count={counter?.count ?? -1}
>{greeting ?? '(none)'} · {counter?.count ?? -1}</span>
