<script>
	// THE SCENARIO: a distributed library component that marks its OWN islands internally.
	// The consuming app imports Panel plain — it never sees (or marks) Tally/Badge. The package's
	// `ogygia.files` declaration is what puts this file on the compile surface. Badge is a
	// SERVER island: its signed-endpoint manifest entry must exist from the PRESCAN of the
	// declared dir (both build legs), or the deferred fetch would 403.
	import Tally from './Tally.svelte' with { wake: 'load' };
	import Badge from './Badge.svelte' with { render: 'deferred' };
</script>

<section data-pkg-panel>
	<h2>Package panel (server HTML)</h2>
	<Tally start={3} />
	<Badge org="acme">
		{#snippet ogygiaFallback()}<span data-pkg-deferred-fallback>badge loading…</span>{/snippet}
	</Badge>
</section>

<style>
	section {
		border: 1px solid #d4d4d8;
		border-radius: 8px;
		padding: 1rem;
	}
</style>
