<script lang="ts">
	// Reads the context its host set — what a CMS block renderer inside a tab does.
	import { getContext } from 'svelte';
	const value = getContext<string | undefined>('in-place-ctx');
</script>

<span data-ctx-read>{value ?? 'MISSING'}</span>
