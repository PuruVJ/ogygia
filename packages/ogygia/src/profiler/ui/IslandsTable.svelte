<script lang="ts">
	/**
	 * THE ISLANDS TABLE — one row per island fingerprint on the profiled page, three sides joined:
	 * the server (SSR ms from the components table, props bytes and lane, seed references), the
	 * build (JS closure weight, interactivity markers) and the browser (hydration timings from the
	 * runtime's beacon). Sortable; a row opens to its modules with bytes, its seed keys, the devalue
	 * culprit, and the one line of advice the numbers support. A finding links here by `#island=`.
	 */
	import type { IslandRow } from './report-data.js';
	import { fmt_ms, fmt_bytes } from './format.js';
	import { sortable } from './sort.svelte.js';
	import { row_id, follow_hash } from './row-anchor.svelte.js';

	let { rows, hasJs, hasClient }: { rows: IslandRow[]; hasJs: boolean; hasClient: boolean } = $props();

	let query = $state('');
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) => r.name.toLowerCase().includes(q) || r.entry.toLowerCase().includes(q) || r.wake.includes(q));
	});
	const s = sortable(() => filtered, 'props_bytes');
	let open = $state<string | null>(null);
	const max_props = Math.max(...rows.map((r) => r.props_bytes), 1);
	const max_js = Math.max(...rows.map((r) => r.js_bytes ?? 0), 1);
	const cols = $derived(9 + (hasJs ? 1 : 0) + (hasClient ? 1 : 0));
	const WAKE_COLOR: Record<string, string> = { load: '#e8734a', idle: '#d9a03d', visible: '#5b8fd6', interaction: '#7ee787', none: '#7d8590' };
	const wake_color = (w: string) => WAKE_COLOR[w] ?? '#b48ead';
	const marks_text = (r: IslandRow) => {
		const i = r.interactivity;
		if (!i) return '—';
		if (r.marks === 0) return 'inert';
		const parts: string[] = [];
		if (i.handlers) parts.push(`${i.handlers} handler${i.handlers === 1 ? '' : 's'}`);
		if (i.state) parts.push(`${i.state} $state`);
		if (i.effects) parts.push(`${i.effects} $effect`);
		if (i.binds) parts.push(`${i.binds} bind:`);
		if (i.actions) parts.push(`${i.actions} use:`);
		return parts.join(' · ');
	};
	$effect(() =>
		follow_hash(
			'island',
			() => rows.map((r) => r.name),
			(k) => {
				query = '';
				open = k;
			}
		)
	);
</script>

<div class="tools">
	<input type="search" placeholder="filter islands…" bind:value={query} aria-label="filter islands" />
	<span class="hint">{filtered.length} of {rows.length} · click a row for its modules, seed keys and advice</span>
</div>
<table>
	<thead>
		<tr>
			<th>island</th>
			<th class="num sort" class:active={s.key === 'copies'} onclick={() => s.click('copies')}>copies<span class="arr">{s.arrow('copies')}</span></th>
			<th>wake</th>
			<th class="num sort" class:active={s.key === 'ssr_ms'} title="the component's server render time, per render" onclick={() => s.click('ssr_ms')}>SSR ms<span class="arr">{s.arrow('ssr_ms')}</span></th>
			<th class="num sort" class:active={s.key === 'props_bytes'} title="the props sidecar as shipped (one per fingerprint)" onclick={() => s.click('props_bytes')}>props<span class="arr">{s.arrow('props_bytes')}</span></th>
			<th title="JSON parses on the fast lane; devalue when a leaf needs it">lane</th>
			<th class="num sort" class:active={s.key === 'refs'} title="props that point into page.data instead of shipping again" onclick={() => s.click('refs')}>seed refs<span class="arr">{s.arrow('refs')}</span></th>
			{#if hasJs}<th class="num sort" class:active={s.key === 'js_sort'} title="unique bytes of the island's module and its preloads" onclick={() => s.click('js_sort')}>JS<span class="arr">{s.arrow('js_sort')}</span></th>{/if}
			<th title="what the build found in the island's components">interactivity</th>
			{#if hasClient}<th class="num sort" class:active={s.key === 'client_ms'} title="wake → hydrated in the browser, p50 (the runtime's beacon)" onclick={() => s.click('client_ms')}>hydrate ms<span class="arr">{s.arrow('client_ms')}</span></th>{/if}
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each s.sorted as r (r.fp)}
			<tr class="row" id={row_id('island', r.name)} class:open={open === r.fp} class:flag={!!r.advice} onclick={() => (open = open === r.fp ? null : r.fp)}>
				<td class="fn"><span class="caret">{open === r.fp ? '▾' : '▸'}</span><b>{r.name}</b></td>
				<td class="num">{r.copies > 1 ? `×${r.copies}` : '1'}</td>
				<td><span class="chip" style="background:{wake_color(r.wake)}">{r.wake}</span></td>
				<td class="num">{r.ssr_ms === null ? '—' : fmt_ms(r.ssr_ms)}</td>
				<td class="num bar-cell">
					<div class="bar" style="width:{Math.max(2, (r.props_bytes / max_props) * 100)}%"></div>
					<b>{fmt_bytes(r.props_bytes)}</b>
				</td>
				<td>{#if r.json}<span class="lane json">json</span>{:else}<span class="lane dev" title={r.culprit ?? ''}>devalue</span>{/if}</td>
				<td class="num">{r.refs ? `${r.refs} → ${r.ref_keys.join(', ')}` : '—'}</td>
				{#if hasJs}
					<td class="num bar-cell">
						{#if r.js_bytes !== null}<div class="bar js" style="width:{Math.max(2, (r.js_bytes / max_js) * 100)}%"></div><b>{fmt_bytes(r.js_bytes)}</b>{:else}—{/if}
					</td>
				{/if}
				<td class="marks" class:inert={r.marks === 0}>{marks_text(r)}</td>
				{#if hasClient}
					<td class="num">{#if r.client}{fmt_ms(r.client.p50_ms)}<span class="hint"> ({r.client.n})</span>{#if r.client.recovered}<span class="lane dev" title="hydrations that discarded the server DOM and re-rendered"> re-rendered ×{r.client.recovered}</span>{/if}{:else}—{/if}</td>
				{/if}
				<td class="flagcell">{#if r.advice}<span class="dotflag" title={r.advice}>!</span>{/if}</td>
			</tr>
			{#if open === r.fp}
				<tr class="details">
					<td colspan={cols}>
						{#if r.advice}<p class="advice">{r.advice}</p>{/if}
						<div class="grid">
							<div>
								<div class="k">entry</div>
								<code class="mono">{r.entry}</code>
								<div class="k">fingerprint{r.variants > 1 ? 's' : ''}</div>
								<code class="mono">{r.fp}{#if r.variants > 1} <span class="hint">and {r.variants - 1} more (each copy has its own props)</span>{/if}</code>
								<div class="k">props</div>
								<div>{fmt_bytes(r.props_bytes)} on the wire{#if r.variants > 1} over {r.variants} sidecars, {fmt_bytes(Math.round(r.props_bytes / r.variants))} each{/if}{#if r.canonical_bytes !== r.props_bytes} · {fmt_bytes(r.canonical_bytes)} before seed references{/if}{#if r.copies > 1 && r.variants === 1} · shared by {r.copies} copies{/if}</div>
								{#if r.culprit}<div class="k">devalue because of</div><code class="mono warn">{r.culprit}</code>{/if}
								{#if r.ref_keys.length}<div class="k">points into page.data</div><div>{r.ref_keys.join(', ')}</div>{/if}
								{#if r.client}
									<div class="k">in the browser</div>
									<div>{r.client.n} hydration{r.client.n === 1 ? '' : 's'} seen · p50 {fmt_ms(r.client.p50_ms)} ms, max {fmt_ms(r.client.max_ms)} ms · module load p50 {fmt_ms(r.client.load_p50_ms)} ms{#if r.client.recovered} · <span class="warn">{r.client.recovered} re-rendered after a hydration mismatch</span>{/if}</div>
										{#if r.client.recovered && r.client.reason}<div class="k">why it was recovered</div><div class="warn">{r.client.reason}</div>{/if}
								{/if}
							</div>
							<div>
								<div class="k">what the browser downloads to wake it{#if r.js_bytes !== null} · {fmt_bytes(r.js_bytes)} in all{/if}</div>
								<p class="explain">
									Every JavaScript file this island needs before it can run: its own code (marked <b>this island</b>) plus the
									shared files it imports — the Svelte runtime, ogygia's hydrate core, shared components, libraries. The
									bundler names shared files by hash. The total is what one visitor pays in JS for this island; the biggest
									file is where to look when that is too much.
								</p>
								{#each r.modules as m (m.url)}
									<div class="mod">
										{#if m.bytes !== null}<div class="bar js" style="width:{Math.max(1, (m.bytes / Math.max(r.modules[0].bytes ?? 1, 1)) * 100)}%"></div>{/if}
										<span class="mono">{m.url.replace(/^.*\/_app\/immutable\//, '')}{#if m.url === r.entry || m.url.replace(/^\.?\//, '') === r.entry.replace(/^\.?\//, '')} <span class="own">this island</span>{/if}</span>
										<span class="num">{m.bytes === null ? '' : fmt_bytes(m.bytes)}</span>
									</div>
									{#if m.inside?.length}
										<div class="inside">{m.inside.join(' · ')}</div>
									{/if}
								{/each}
							</div>
						</div>
					</td>
				</tr>
			{/if}
		{/each}
	</tbody>
</table>

<style>
	.tools {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
		margin: 6px 0 8px;
	}
	.tools input {
		font: inherit;
		font-size: 13px;
		background: var(--bg-raised);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 5px 10px;
		min-width: 240px;
	}
	.tools .hint,
	.hint {
		color: var(--text-faint);
		font-size: 12px;
	}
	tr.row {
		cursor: pointer;
	}
	tr.row:hover td {
		background: var(--bg-raised);
	}
	tr.row.open td {
		border-bottom-color: transparent;
	}
	.caret {
		color: var(--text-faint);
		font-size: 10px;
		margin-right: 4px;
	}
	.chip {
		display: inline-block;
		font-size: 11px;
		color: var(--bg-sunken);
		font-weight: 600;
		border-radius: 999px;
		padding: 0 8px;
		line-height: 17px;
	}
	.lane {
		font-size: 11px;
		border-radius: 4px;
		padding: 1px 6px;
	}
	.lane.json {
		color: var(--good);
		border: 1px solid #2a4a33;
	}
	.lane.dev {
		color: var(--warn);
		border: 1px solid #5a4a20;
	}
	.bar-cell {
		position: relative;
		min-width: 90px;
	}
	.bar-cell .bar {
		position: absolute;
		left: 4px;
		right: 4px;
		bottom: 3px;
		height: 3px;
		max-width: calc(100% - 8px);
		background: var(--c-orange);
		border-radius: 2px;
		opacity: 0.7;
	}
	.bar.js {
		background: var(--c-blue);
	}
	.marks {
		font-size: 12px;
		color: var(--text-dim);
	}
	.marks.inert {
		color: var(--warn);
	}
	.flagcell {
		width: 20px;
	}
	.dotflag {
		display: inline-block;
		width: 16px;
		height: 16px;
		line-height: 16px;
		text-align: center;
		border-radius: 50%;
		background: var(--warn);
		color: var(--bg-sunken);
		font-weight: 700;
		font-size: 11px;
	}
	tr.details td {
		background: var(--bg-raised);
		padding: 10px 14px 12px;
		border-bottom: 1px solid var(--line);
	}
	.advice {
		margin: 0 0 8px;
		padding: 6px 10px;
		background: var(--bg-raised);
		border-left: 3px solid var(--warn);
		border-radius: 4px;
		font-size: 12.5px;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 24px;
		font-size: 12.5px;
	}
	.k {
		color: var(--text-faint);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 6px;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		word-break: break-all;
	}
	.mono.warn {
		color: var(--warn);
	}
	.explain {
		margin: 2px 0 6px;
		color: var(--text-dim);
		font-size: 12px;
		line-height: 1.45;
	}
	.own {
		font-size: 10.5px;
		color: var(--c-orange);
		border: 1px solid #5a3a2a;
		border-radius: 999px;
		padding: 0 6px;
		margin-left: 6px;
	}
	.inside {
		margin: -1px 0 4px 8px;
		color: var(--text-faint);
		font-size: 11px;
		word-break: break-all;
	}
	.mod {
		position: relative;
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 2px 4px;
	}
	.mod .bar {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		border-radius: 1px;
		opacity: 0.6;
	}
	.mod .num {
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
