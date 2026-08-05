<script lang="ts">
	// The island receives `config` (a snapshot with a Map + Set) captured from this host scope, and
	// mutates it in its own script. The host markup below only READS config — writing to a captured
	// var from host markup is a build error, so the mutation can only be shown from inside the island.
	import SnapshotMutator from '$lib/playground/SnapshotMutator.svelte' with { hydrate: 'load' };

	const config = {
		count: 1,
		meta: new Map<string, number>([['seed', 0]]),
		roles: new Set<string>(['guest'])
	};
</script>

<main class="shell docs-main">
	<section id="mutation-guard">
		<span class="eyebrow">dev warning</span>
		<div class="section-header">
			<h2>Mutation guard</h2>
			<p class="section-lede">
				Captured host state crosses the boundary as a one-way devalue snapshot. Writing to it
				inside an island updates nothing. The runtime helps you notice.
			</p>
		</div>

		<div class="prose" style="margin-bottom: 2rem;">
			<p>
				This page captures a <code>config</code> object (a <code>Map</code> and a
				<code>Set</code> survive the boundary) and passes it to the island below. The island mutates
				all three fields in <code>onMount</code>. Because the prop is a deserialized copy with no
				reactive link back here, those writes are a no-op — the host's <code>config</code> is
				untouched.
			</p>
			<p>
				<strong>The warning is dev-only, so it is not faked here.</strong> Under
				<code>vite dev</code> the runtime wraps the captured prop in a deep <code>Proxy</code> and
				logs a warning once per mutated path — you would see something like
				<code>config.count</code>, <code>config.meta.set()</code>, and
				<code>config.roles.add()</code> in the console. A production build ships the plain object
				with no proxy and no warning, so the mutation is silent and free. Open this page under
				<code>pnpm --filter docs dev</code> with the console open to see the real warnings; this
				preview build intentionally shows none.
			</p>
			<p>
				The fix is always the same: keep mutable state inside the island
				(<code>$state</code> seeded from the prop), not in the dead shell. And two islands never
				share reactive state — if they must agree on something, both read it from the server.
			</p>
		</div>

		<SnapshotMutator {config} />
	</section>
</main>
