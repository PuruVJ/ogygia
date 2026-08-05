<script lang="ts">
	// The captured-snapshot mutation guard, demonstrated. `config` is captured from host scope and
	// crosses the boundary as a devalue snapshot (the Map and Set survive). This island mutates it in
	// its own script — a no-op, because the prop is a deserialized copy with no link back to the host.
	// In DEV the runtime wraps the prop in a Proxy and warns once per path; in PROD it ships the plain
	// object and the mutation is silent. A host-markup write to a captured var is a BUILD error, so it
	// can only be shown from inside the island like this.
	import { onMount } from 'svelte';

	let { config }: { config: { count: number; meta: Map<string, number>; roles: Set<string> } } =
		$props();

	let done = $state(false);

	onMount(() => {
		config.count = config.count + 1; // object write  -> dev warns 'config.count'
		config.meta.set('touched', 1); // Map mutator   -> dev warns 'config.meta.set()'
		config.roles.add('admin'); // Set mutator   -> dev warns 'config.roles.add()'
		done = true;
	});
</script>

<div class="widget" data-snapshot-mutator style="max-width: 340px;">
	<span class="widget-label">captured snapshot (mutated in-island)</span>
	<p class="widget-meta" data-count style="margin-top: 0;">count = {config.count}</p>
	<p class="widget-meta" data-meta>meta size = {config.meta.size}</p>
	<p class="widget-meta" data-roles>roles = {[...config.roles].join(', ')}</p>
	<p class="widget-meta" data-done>
		{done ? 'mutated locally — host is unchanged' : 'pending'}
	</p>
</div>
