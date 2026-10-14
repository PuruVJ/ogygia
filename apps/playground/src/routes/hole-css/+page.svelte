<script lang="ts">
	// HOLE CSS THROUGH PACKAGES AND BARRELS (e2e/hole-css.spec.ts): a server-only hole whose island
	// renders, after a click, components taken by name from a workspace package's TypeScript barrel
	// and from a local barrel. Their scoped CSS must reach the page; the barrels' other components'
	// must not.
	import AccountHole from '#lib/holecss/AccountHole.svelte' with { render: 'deferred' };
</script>

<h1 data-page>hole css</h1>
<AccountHole>
	{#snippet ogygiaFallback()}<p data-account-fallback>loading…</p>{/snippet}
</AccountHole>
