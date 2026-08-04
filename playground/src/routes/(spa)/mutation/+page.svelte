<script lang="ts">
	// Captured-snapshot mutation guard demo. `config` is captured from host scope and crosses the
	// boundary as a devalue snapshot (a Map + Set survive). The island mutates it inside its own
	// script — a no-op that the DEV guard Proxy flags. The host markup below never writes to `config`
	// (that would be a build error), it only reads it.
	import MutatingIsland from '$lib/MutatingIsland.svelte' with { hydrate: 'load' };

	const config = {
		count: 1,
		meta: new Map<string, number>([['seed', 0]]),
		roles: new Set<string>(['guest'])
	};
</script>

<h1 data-static-shell>Captured-snapshot mutation guard</h1>
<p data-static-shell>
	The island receives <code>config</code> (a snapshot with a Map + Set) and mutates it in its own
	script. In dev the runtime warns once per path; in prod it is silent and the mutation is a no-op.
</p>

<MutatingIsland {config} />
