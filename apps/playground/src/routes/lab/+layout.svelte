<script lang="ts">
	// The island below lives in the LAYOUT — shared by every /lab route — which is exactly what the
	// server-delta "keep unchanged regions" test needs. `wake: 'load'` = a normal hydrate island.
	import LabPersist from '$lib/lab/LabPersist.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<header class="lab-head">
	<nav>
		<a href="/lab">🧪 Lab home</a>
		<a href="/lab/a" data-lab-a>Page A</a>
		<a href="/lab/b" data-lab-b>Page B</a>
		<a href="/lab/deep/x">Deep persist</a>
		<a href="/lab/stream">Streaming</a>
		<a href="/lab/wire">Serialization</a>
		<a href="/">← playground</a>
	</nav>
</header>

<LabPersist />

<main>
	{@render children()}
</main>

<style>
	.lab-head {
		border-bottom: 1px solid #e2e8f0;
		margin-bottom: 12px;
	}
	.lab-head nav {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		padding: 8px 0;
	}
	.lab-head a {
		color: #2563eb;
		text-decoration: none;
		font-weight: 600;
	}
	main :global(h1) {
		margin-top: 0.4em;
	}
</style>
