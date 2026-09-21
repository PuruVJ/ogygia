<script lang="ts">
	/**
	 * The global rail — on every profiler page (Shell renders it). Brand, the top-level nav, the
	 * recordings this browser has kept, live status, and the theme switch. A `wake:'load'` island so
	 * it can read the local store (IndexedDB) for kept reports and poll status.
	 *
	 * HOSTED DB SEAM: `server` is the list a company-hosted store would return (the reports the
	 * backend holds, across instances and teammates). Today it is empty and the rail shows what THIS
	 * browser kept ("the browser is the database"); when the backend lands, the router fills `server`
	 * and the two lists merge — nothing else here changes. `live` is the same seam for a status feed.
	 */
	import { list_reports } from './store.js';
	import ThemeSwitch from './ThemeSwitch.svelte';

	let { base, current = null }: { base: string; current?: string | null } = $props();

	// reports the durable store holds (SQLite/Redis/Postgres), shared across instances and teammates —
	// fetched from `/reports.json`; empty when no store is configured (then the rail is local-only)
	let server = $state<{ id: string; label: string; page?: string; created: number }[]>([]);
	$effect(() => {
		fetch(`${base}/reports.json`, { headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : []))
			.then((rows) => (server = Array.isArray(rows) ? rows : []))
			.catch(() => (server = []));
	});

	// LIVE STATUS — polled from the instance (`/status.json`): is a recording running, how many
	// requests are in flight, memory, how many reports it holds. The rail's pulse.
	let live = $state<{ recording: boolean; inflight: number; rss_mb: number; reports: number } | null>(null);
	$effect(() => {
		let alive = true;
		const poll = async () => {
			try {
				const r = await fetch(`${base}/status.json`, { headers: { accept: 'application/json' } });
				if (r.ok && alive) live = await r.json();
			} catch {
				/* offline / gone */
			}
		};
		poll();
		const t = setInterval(poll, 4000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	});

	type Row = { id: string; label: string; page?: string; created: number; where: 'server' | 'local' };
	let local = $state<Row[]>([]);
	$effect(() => {
		list_reports()
			.then((rows) =>
				rows
					.sort((a, b) => b.at - a.at)
					.slice(0, 12)
					.map(
						(r): Row => ({
							id: r.id,
							label: r.page ?? r.label ?? r.id,
							page: r.page ?? undefined,
							created: r.at,
							where: 'local'
						})
					)
			)
			.then((rows) => (local = rows))
			.catch(() => (local = []));
	});
	// server-held reports first, then browser-only ones; a report in both shows ONCE (server wins)
	const rows = $derived.by<Row[]>(() => {
		const seen = new Set<string>();
		const out: Row[] = [];
		for (const s of server) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			out.push({ ...s, where: 'server' });
		}
		for (const l of local) {
			if (seen.has(l.id)) continue;
			seen.add(l.id);
			out.push(l);
		}
		return out.slice(0, 16);
	});
	const ago = (t: number) => {
		const s = Math.max(0, (Date.now() - t) / 1000);
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		if (s < 86400) return `${Math.round(s / 3600)}h ago`;
		return `${Math.round(s / 86400)}d ago`;
	};
	const nav = [
		{ href: base, label: 'Dashboard', icon: '▦' },
		{ href: `${base}/site`, label: 'Whole site', icon: '◈' },
		{ href: `${base}/view`, label: 'Import .ogp', icon: '↥' }
	];
	const is_here = (href: string) => typeof window !== 'undefined' && window.location.pathname === new URL(href, window.location.origin).pathname;
</script>

<aside class="rail">
	<a class="brand" href={base}>
		<span class="mark">◑</span>
		<span class="wordmark">ogygia<b>profiler</b></span>
	</a>

	<nav>
		{#each nav as n (n.href)}
			<a href={n.href} class="navi" class:on={is_here(n.href)}><span class="ni">{n.icon}</span>{n.label}</a>
		{/each}
	</nav>

	<div class="status" title={live ? `${live.inflight} in flight · ${live.rss_mb} MB · ${live.reports} in memory` : ''}>
		<span class="dot" class:run={live?.recording}></span>
		{#if live?.recording}
			recording…
		{:else if live}
			ready · {live.inflight} in flight
		{:else}
			ready
		{/if}
	</div>

	<div class="recent">
		<div class="rh">Recent recordings</div>
		{#if rows.length}
			<ul>
				{#each rows as r (r.where + r.id)}
					<li>
						<a href="{base}/report/{r.id}" class:cur={r.id === current}>
							<span class="rl">{r.label}</span>
							<span class="rm">{ago(r.created)}{#if r.where === 'server'} · shared{/if}</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty">None kept in this browser yet. On a report, hit <b>Keep</b> to pin it here.</p>
		{/if}
	</div>

	<div class="foot">
		<ThemeSwitch />
	</div>
</aside>

<style>
	.rail {
		position: fixed;
		left: 0;
		top: 0;
		width: 236px;
		height: 100vh;
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px 14px;
		border-right: 1px solid var(--line);
		background: var(--bg-panel);
		overflow-y: auto;
		z-index: 10;
	}
	@media (max-width: 860px) {
		.rail {
			position: static;
			width: auto;
			height: auto;
		}
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
		text-decoration: none;
		color: var(--text);
		padding: 2px 4px;
	}
	.brand:hover {
		text-decoration: none;
	}
	.mark {
		font-size: 20px;
		color: var(--accent);
	}
	.wordmark {
		font-family: var(--font-display);
		font-size: 17px;
		letter-spacing: -0.01em;
	}
	.wordmark b {
		font-weight: 600;
		color: var(--accent);
		margin-left: 3px;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.navi {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 10px;
		border-radius: var(--r-sm);
		color: var(--text-dim);
		font-size: 13px;
		text-decoration: none;
	}
	.navi:hover {
		background: var(--bg-hover);
		color: var(--text);
		text-decoration: none;
	}
	.navi.on {
		background: var(--accent-deep);
		color: var(--accent-strong);
	}
	.ni {
		width: 16px;
		text-align: center;
		opacity: 0.85;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--text-faint);
		padding: 0 10px;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.dot.run {
		background: var(--accent);
		box-shadow: 0 0 8px var(--accent);
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.4;
		}
	}
	.recent {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.rh {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		padding: 0 10px 6px;
	}
	.recent ul {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
	}
	.recent a {
		display: block;
		padding: 6px 10px;
		border-radius: var(--r-sm);
		text-decoration: none;
		color: var(--text-dim);
	}
	.recent a:hover {
		background: var(--bg-hover);
		text-decoration: none;
	}
	.recent a.cur {
		background: var(--accent-deep);
	}
	.rl {
		display: block;
		font-size: 12.5px;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono);
	}
	.rm {
		display: block;
		font-size: 10.5px;
		color: var(--text-faint);
	}
	.empty {
		font-size: 12px;
		color: var(--text-faint);
		padding: 0 10px;
		line-height: 1.5;
	}
	.foot {
		border-top: 1px solid var(--line);
		padding-top: 12px;
	}
</style>
