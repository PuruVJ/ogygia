<script lang="ts">
	// A hydrate island placed in the /lab LAYOUT, so it is SHARED across /lab/a and /lab/b. On an SPA
	// nav between those two routes the island's fingerprint (entry + props) is IDENTICAL, so the
	// server-delta protocol tells the server to SKIP re-rendering it — the client keeps the live island.
	//
	// PROOF: `onMount` runs once per real mount. If the island is kept, it does NOT re-run on nav, so
	// the hydrate-time and your click count both SURVIVE. If server-delta were broken (the island got
	// re-mounted), onMount would fire again — hydrate-time changes and clicks reset to 0.
	import { onMount } from 'svelte';

	let clicks = $state(0);
	let mounts = $state(0);
	let hydratedAt = $state('(server render — not yet hydrated)');

	onMount(() => {
		mounts += 1;
		hydratedAt = new Date().toLocaleTimeString() + '.' + String(Date.now() % 1000).padStart(3, '0');
	});
</script>

<div class="persist island" data-lab-persist>
	<strong>🔒 Persistent island (lives in the /lab layout)</strong>
	<div class="row">
		<button data-lab-inc onclick={() => (clicks += 1)}>
			clicks: <b data-lab-clicks>{clicks}</b>
		</button>
		<span>hydrated at <code data-lab-hydrated>{hydratedAt}</code></span>
		<span>times mounted: <code data-lab-mounts>{mounts}</code></span>
	</div>
	<small>
		Click a few times, then use the <b>A ⇄ B</b> links. Kept alive → clicks + hydrate-time + mount
		count stay the same. Re-mounted → they reset. (Network tab: the delta response marks this region
		<code>data-og-skipped</code>.)
	</small>
</div>

<style>
	.persist {
		border: 2px solid #2563eb;
		border-radius: 10px;
		padding: 12px 14px;
		background: #eff6ff;
		margin: 8px 0 16px;
	}
	.persist .row {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
		margin: 6px 0;
	}
	.persist small {
		color: #475569;
		display: block;
		margin-top: 4px;
	}
	.persist button {
		padding: 4px 10px;
	}
	code {
		background: #dbeafe;
		padding: 1px 5px;
		border-radius: 4px;
	}
</style>
