<script lang="ts">
	// DEMO of the captured-snapshot mutation guard (task 1b). This island receives a captured host
	// object as a prop and — on purpose, to show what NOT to do — mutates it inside its own script.
	// The mutation is a no-op (the prop is a deserialized snapshot); in DEV the runtime's guard Proxy
	// warns once per path. In PROD the prop is the plain object, so the mutations are silent.
	// NOTE: the mutations live INSIDE the island component (not the host markup) — a host-markup write
	// to a captured var is a BUILD error (task 1a), so it cannot be demoed at runtime.
	import { onMount } from 'svelte';

	let { config }: { config: { count: number; meta: Map<string, number>; roles: Set<string> } } = $props();

	let done = $state(false);

	onMount(() => {
		config.count = config.count + 1; // object property write -> warns 'config.count'
		config.meta.set('touched', 1); // Map mutator -> warns 'config.meta.set()'
		config.roles.add('admin'); // Set mutator -> warns 'config.roles.add()'
		done = true;
	});
</script>

<div class="island" data-mutation-island>
	<p data-mutation-count>count={config.count}</p>
	<p data-mutation-done>{done ? 'mutated' : 'pending'}</p>
</div>
