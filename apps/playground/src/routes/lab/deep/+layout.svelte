<script lang="ts">
	let { children } = $props();
</script>

<section class="deep-intro">
	<h1>Deep, non-layout persisted island</h1>
	<p>
		The green island lives <b>inside each page's own markup</b>, three wrappers deep — NOT in a
		shared layout (it's in the <code>+page</code>, which fully swaps on nav). Both pages sit it in the
		SAME stable slot (<code>.shell → .rail → .slot → .deeper</code>) with the same props, while all
		the OTHER content differs. The state-delta reconciler matches it by key at that matched position
		and keeps the live island; the rest of the page re-renders around it.
	</p>
	<p class="note">
		Architecture note: the reconcile is a keyed <b>tree morph</b>, so a kept island's parent chain
		must line up across the nav (a stable slot, or a shared layout). If the two pages wrapped it in
		<em>completely different</em> structure, the whole subtree would be replaced and the island would
		re-mount — for that case you persist the STATE instead (a named <code>og.wire</code> id, like the
		session cart), not the DOM node.
	</p>
	<nav>
		<a href="/lab/deep/x" data-deep-x>Page X (nested in cards)</a>
		<a href="/lab/deep/y" data-deep-y>Page Y (nested in a sidebar layout)</a>
		<a href="/lab">← lab home</a>
	</nav>
	<p class="how">
		<b>Test:</b> open X, click the green <b>clicks</b> up to 3, note hydrate-time + mounts:1. Bounce
		X ⇄ Y. ✅ kept = clicks/time/mounts unchanged though the wrappers differ. ❌ = they reset.
	</p>
</section>
<hr />
{@render children()}

<style>
	.deep-intro nav {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		margin: 8px 0;
	}
	.deep-intro a {
		color: #16a34a;
		font-weight: 600;
	}
	.note {
		background: #fffbeb;
		border-left: 3px solid #f59e0b;
		padding: 8px 12px;
		font-size: 0.92em;
	}
	.how {
		background: #f1f5f9;
		border-radius: 8px;
		padding: 8px 12px;
	}
</style>
