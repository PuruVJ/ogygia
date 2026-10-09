<script lang="ts">
	// A hydrate island NOT in any shared layout — it is rendered deep inside each page's own markup.
	// Because /lab/deep/x and /lab/deep/y both place it with IDENTICAL props, its region fingerprint
	// matches on both, so on an SPA nav between them the state-delta reconciler MATCHES it by key and
	// KEEPS the live island — even though the surrounding DOM (the wrappers around it) is different.
	//
	// PROOF is the same as LabPersist: onMount runs once per real mount. Kept → clicks + hydrate-time
	// + mount count survive the nav. Re-mounted → they reset.
	import { onMount } from 'svelte';

	let { label = 'deep' }: { label?: string } = $props();
	let clicks = $state(0);
	let mounts = $state(0);
	let hydratedAt = $state('(server render)');

	onMount(() => {
		mounts += 1;
		hydratedAt = new Date().toLocaleTimeString() + '.' + String(Date.now() % 1000).padStart(3, '0');
	});
</script>

<div class="deep island" data-deep-counter={label}>
	<strong>🪆 Deep island “{label}”</strong>
	<div class="row">
		<button data-deep-inc onclick={() => (clicks += 1)}>
			clicks: <b data-deep-clicks>{clicks}</b>
		</button>
		<span>hydrated at <code data-deep-hydrated>{hydratedAt}</code></span>
		<span>mounts: <code data-deep-mounts>{mounts}</code></span>
	</div>
</div>

<style>
	.deep {
		border: 2px solid #16a34a;
		border-radius: 10px;
		padding: 12px 14px;
		background: #f0fdf4;
	}
	.deep .row {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 6px;
	}
	.deep button {
		padding: 4px 10px;
	}
	code {
		background: #dcfce7;
		padding: 1px 5px;
		border-radius: 4px;
	}
</style>
