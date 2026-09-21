<script lang="ts">
	/**
	 * THE COMPARISON BODY: summary deltas, phases, components and functions side by side, findings
	 * that appeared or went away. One renderer, two sources — the server's comparison (Compare
	 * page) or one computed in the browser from the store (LocalCompare island). A positive delta
	 * is a regression (b slower than a) and reads red.
	 */
	import { fmt_ms } from './format.js';
	import type { Comparison } from '../compare.js';

	let { base, cmp }: { base: string; cmp: Comparison } = $props();

	const when = (ms: number) => new Date(ms).toLocaleString();
	const fmt = (n: number, unit: string) =>
		unit === 'ms' ? fmt_ms(n) + ' ms' : unit === 'KB' ? Math.round(n) + ' KB' : String(Math.round(n));
	const sign = (d: number, unit: string) => (d > 0 ? '+' : '') + (unit === 'ms' ? fmt_ms(d) : Math.round(d));
	const pct = (a: number, d: number) => (a > 0 ? ` (${d > 0 ? '+' : ''}${((d / a) * 100).toFixed(0)}%)` : '');
	const cls = (d: number, floor = 0.5) => (d > floor ? 'worse' : d < -floor ? 'better' : '');
	const comps = $derived(cmp.components.filter((r) => Math.abs(r.d_self) >= 0.05 || Math.abs(r.d_total) >= 0.5).slice(0, 40));
	const fns = $derived(cmp.functions.filter((r) => Math.abs(r.d_self) >= 0.05).slice(0, 40));
</script>

	<h1>Compare <small>{cmp.a.label} → {cmp.b.label}</small></h1>
	<p class="hint">
		<a href={base}>← dashboard</a> ·
		<b>A</b> <a href="{base}/report/{cmp.a.id}">{cmp.a.label}</a> ({when(cmp.a.created)}) ·
		<b>B</b> <a href="{base}/report/{cmp.b.id}">{cmp.b.label}</a> ({when(cmp.b.created)}) ·
		<a href="{base}/compare/{cmp.b.id}/{cmp.a.id}">swap</a>. A positive delta means B is slower.
	</p>

	<h2>Summary</h2>
	<table>
		<thead><tr><th></th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr></thead>
		<tbody>
			{#each cmp.summary as r (r.label)}
				<tr>
					<td class="fn">{r.label}</td>
					<td class="num">{fmt(r.a, r.unit)}</td>
					<td class="num">{fmt(r.b, r.unit)}</td>
					<td class="num {cls(r.d, r.unit === 'ms' ? 0.5 : 0)}"><b>{sign(r.d, r.unit)}</b>{pct(r.a, r.d)}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	{#if cmp.phases.length}
		<h2>Phases</h2>
		<table>
			<thead><tr><th>phase</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr></thead>
			<tbody>
				{#each cmp.phases as p (p.phase)}
					<tr>
						<td class="fn">{p.label}</td>
						<td class="num">{fmt_ms(p.a)} ms</td>
						<td class="num">{fmt_ms(p.b)} ms</td>
						<td class="num {cls(p.d)}"><b>{sign(p.d, 'ms')}</b>{pct(p.a, p.d)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if cmp.findings.added.length || cmp.findings.gone.length}
		<h2>Findings</h2>
		{#each cmp.findings.added as f (f)}<p class="finding worse">+ {f}</p>{/each}
		{#each cmp.findings.gone as f (f)}<p class="finding better">− {f}</p>{/each}
	{/if}

	{#if cmp.paths.length}
		<h2>Paths to fix <span class="hint" style="font-weight:400">(by change)</span></h2>
		<p class="hint">Each path is the hot functions under one caller. A path that shrank is a fix that landed; one that appeared is new work under that caller.</p>
		<table>
			<thead><tr><th>caller</th><th>where</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th><th>functions</th></tr></thead>
			<tbody>
				{#each cmp.paths as p (p.owner)}
					<tr>
						<td class="fn"><b>{p.owner}</b>{#if p.only}<span class="hint"> (only in {p.only.toUpperCase()})</span>{/if}</td>
						<td class="file">{p.file}{#if p.line > 0}:{p.line}{/if}</td>
						<td class="num">{p.a_ms ? fmt_ms(p.a_ms) : '—'}</td>
						<td class="num">{p.b_ms ? fmt_ms(p.b_ms) : '—'}</td>
						<td class="num {cls(p.d_ms, 1)}"><b>{sign(p.d_ms, 'ms')}</b>{pct(p.a_ms, p.d_ms)}</td>
						<td class="hint">{(p.b_fns.length ? p.b_fns : p.a_fns).slice(0, 6).join(', ')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if cmp.gc_makers.length}
		<h2>Garbage makers <span class="hint" style="font-weight:400">(what each line allocated and the GC it caused, by change)</span></h2>
		<table>
			<thead><tr><th>line</th><th>in</th><th class="num">A allocated</th><th class="num">B allocated</th><th class="num">Δ</th><th class="num">A GC ms</th><th class="num">B GC ms</th><th class="num">Δ</th></tr></thead>
			<tbody>
				{#each cmp.gc_makers.slice(0, 25) as m (m.name + m.caller)}
					<tr>
						<td class="fn"><b>{m.name}</b>{#if m.caller}<span class="hint"> ← {m.caller}</span>{/if}{#if m.only}<span class="hint"> (only in {m.only.toUpperCase()})</span>{/if}</td>
						<td class="fn">{m.component ?? '—'}</td>
						<td class="num">{m.a_mb} MB</td>
						<td class="num">{m.b_mb} MB</td>
						<td class="num {cls(m.d_mb, 0.5)}"><b>{m.d_mb > 0 ? '+' : ''}{m.d_mb} MB</b>{pct(m.a_mb, m.d_mb)}</td>
						<td class="num">{fmt_ms(m.a_gc_ms)}</td>
						<td class="num">{fmt_ms(m.b_gc_ms)}</td>
						<td class="num {cls(m.d_gc_ms, 0.5)}"><b>{sign(m.d_gc_ms, 'ms')}</b></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<h2>Components <span class="hint" style="font-weight:400">(by change in self time)</span></h2>
	{#if comps.length}
		<table>
			<thead>
				<tr
					><th>component</th><th class="num">self A</th><th class="num">self B</th><th class="num">Δ self</th
					><th class="num">total A</th><th class="num">total B</th><th class="num">Δ total</th><th class="num">renders</th></tr
				>
			</thead>
			<tbody>
				{#each comps as r (r.name)}
					<tr>
						<td class="fn"><b>{r.name}</b>{#if r.only}<span class="hint"> only in {r.only.toUpperCase()}</span>{/if}</td>
						<td class="num">{fmt_ms(r.a_self)}</td>
						<td class="num">{fmt_ms(r.b_self)}</td>
						<td class="num {cls(r.d_self, 0.05)}"><b>{sign(r.d_self, 'ms')}</b></td>
						<td class="num">{fmt_ms(r.a_total)}</td>
						<td class="num">{fmt_ms(r.b_total)}</td>
						<td class="num {cls(r.d_total)}">{sign(r.d_total, 'ms')}</td>
						<td class="num">{r.a_calls ?? '—'} → {r.b_calls ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">No component changed by more than 0.05 ms.</p>
	{/if}

	<h2>Functions <span class="hint" style="font-weight:400">(by change in self time)</span></h2>
	{#if fns.length}
		<table>
			<thead>
				<tr><th>function</th><th>where</th><th class="num">self A</th><th class="num">self B</th><th class="num">Δ</th><th class="num">calls</th></tr>
			</thead>
			<tbody>
				{#each fns as r (r.name + r.file)}
					<tr>
						<td class="fn"><b>{r.name}</b>{#if r.only}<span class="hint"> only in {r.only.toUpperCase()}</span>{/if}</td>
						<td class="file">{r.file}{#if r.line > 0}:{r.line}{/if}</td>
						<td class="num">{fmt_ms(r.a_self)}</td>
						<td class="num">{fmt_ms(r.b_self)}</td>
						<td class="num {cls(r.d_self, 0.05)}"><b>{sign(r.d_self, 'ms')}</b>{pct(r.a_self, r.d_self)}</td>
						<td class="num">{r.a_calls ?? '—'} → {r.b_calls ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">No function changed by more than 0.05 ms.</p>
	{/if}

<style>
	.worse {
		color: var(--bad);
	}
	.better {
		color: var(--good);
	}
	.finding {
		margin: 4px 0;
		font-size: 13px;
	}
</style>
