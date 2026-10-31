<script lang="ts">
	// Ordinary island — raw Svelte getContext, no ogygia import. Reads the plain object, the string,
	// and the LIVE transportable the layout set via the drop-in setContext, across the island split.
	import { getContext } from 'svelte';
	import type { SharedCounter } from '$lib/counter-object.svelte.js';

	let { label = 'load' }: { label?: string } = $props();

	const boot = getContext<{ theme: string; user: string } | undefined>('boot');
	const appName = getContext<string | undefined>('appName');
	const room = getContext<SharedCounter | undefined>('room');
</script>

<span
	class="island"
	data-setctx-reader={label}
	data-setctx-theme={boot?.theme ?? ''}
	data-setctx-user={boot?.user ?? ''}
	data-setctx-app={appName ?? ''}
	data-setctx-count={room?.count ?? -1}
	data-setctx-live={room ? 'true' : 'false'}
>boot={boot?.theme ?? '(none)'}/{boot?.user ?? '(none)'} · app={appName ?? '(none)'} · count={room?.count ?? -1}</span>
