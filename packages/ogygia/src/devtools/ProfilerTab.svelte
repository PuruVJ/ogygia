<script>
	/**
	 * The Profiler tab — a dev-only front door to the SSR profiler. "Profile this page" embeds the
	 * profiler's own `/run` page in an iframe, so the Windows-style progress bar and then the full report
	 * render right here; a button opens the finished report in a new tab. The profiler must be enabled
	 * (`ogygia({ profiler: true })`) — if it isn't, this shows how to turn it on. Dev-only, like the rest
	 * of devtools, so the profiler UI is open (no key needed here).
	 */
	import { onMount } from 'svelte';

	// The tab receives the shared refresh pulse; unused here (this tab drives itself), accepted for parity.
	let { tick = 0 } = $props();
	void tick;

	const BASE = '/__profiler';
	let path = $state('/');
	let runs = $state(5);
	let available = $state(/** @type {boolean | null} */ (null)); // null = probing
	let src = $state(''); // the /run page in the iframe (empty = nothing started)
	let reportUrl = $state(''); // the finished report URL, from the iframe's postMessage

	onMount(() => {
		path = location.pathname;
		// Probe: a mounted profiler answers its base (200/redirect); an un-mounted one 404s.
		fetch(BASE, { method: 'GET', redirect: 'manual' })
			.then((r) => (available = r.status !== 404))
			.catch(() => (available = false));
		const on_msg = (/** @type {MessageEvent} */ e) => {
			if (e.origin === location.origin && e.data && e.data.type === 'ogygia:profiled' && e.data.url) {
				reportUrl = String(e.data.url);
			}
		};
		window.addEventListener('message', on_msg);
		return () => window.removeEventListener('message', on_msg);
	});

	function start() {
		reportUrl = '';
		const p = path.startsWith('/') ? path : '/' + path;
		// cache-bust so re-running the same path reloads the iframe
		src = `${BASE}/run?p=${encodeURIComponent(p)}&runs=${runs}&_=${tick}${Math.round(performance.now())}`;
	}
	function open_tab() {
		const u = reportUrl || src;
		if (u) window.open(u, '_blank', 'noopener');
	}
</script>

<div class="pf">
	{#if available === false}
		<div class="notice">
			<p class="h">The SSR profiler isn't mounted.</p>
			<p>Turn it on in <code>vite.config.ts</code>:</p>
			<pre>ogygia(&#123; profiler: true &#125;)</pre>
			<p><code>ogygia.handle()</code> mounts it for you — then reload this page.</p>
		</div>
	{:else}
		<div class="row">
			<label>path <input bind:value={path} spellcheck="false" /></label>
			<label>renders <input class="n" type="number" min="1" max="50" bind:value={runs} /></label>
			<button class="go" onclick={start}>Profile this page</button>
			{#if src}<button class="open" onclick={open_tab} title="open the report in a new tab">↗ new tab</button>{/if}
		</div>
		{#if src}
			<iframe {src} title="profiler report" referrerpolicy="no-referrer"></iframe>
		{:else}
			<p class="hint">
				Renders <code>{path}</code> through your real server {runs}× and shows where the time went —
				components, functions, allocations, and outbound calls. The report opens right here.
			</p>
		{/if}
	{/if}
</div>

<style>
	.pf {
		display: flex;
		flex-direction: column;
		gap: 10px;
		height: 100%;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: #94a3b8;
	}
	input {
		background: #0d1526;
		border: 1px solid rgba(148, 163, 184, 0.25);
		border-radius: 6px;
		color: #e2e8f0;
		font: inherit;
		padding: 4px 7px;
	}
	input:not(.n) {
		width: 15rem;
	}
	.n {
		width: 3.5rem;
	}
	.go {
		padding: 5px 12px;
		border-radius: 7px;
		border: 1px solid #0d9488;
		background: #14b8a6;
		color: #022;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.open {
		margin-left: auto;
		padding: 5px 10px;
		border-radius: 7px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		background: #0d1526;
		color: #94a3b8;
		font: inherit;
		cursor: pointer;
	}
	.open:hover {
		color: #e2e8f0;
	}
	iframe {
		flex: 1;
		min-height: 260px;
		width: 100%;
		border: 1px solid rgba(148, 163, 184, 0.25);
		border-radius: 8px;
		background: #fff;
	}
	.notice {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 44ch;
		color: #cbd5e1;
		line-height: 1.6;
	}
	.notice .h {
		color: #e2e8f0;
		font-weight: 600;
	}
	.notice code,
	.notice pre {
		background: rgba(148, 163, 184, 0.16);
		color: #5eead4;
		border-radius: 5px;
	}
	.notice code {
		padding: 1px 5px;
	}
	.notice pre {
		padding: 8px 10px;
		margin: 0;
		overflow-x: auto;
	}
	.hint {
		color: #94a3b8;
		line-height: 1.6;
		max-width: 52ch;
	}
	code {
		color: #5eead4;
	}
</style>
