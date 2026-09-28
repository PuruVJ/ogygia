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
	const mb = (b: number) => (!b ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
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
		<thead><tr><th><span class="sr-only">what</span></th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr></thead>
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

	{#if cmp.order}
		{@const o = cmp.order}
		<!-- the run order trap: the later report ran on the heap the earlier one's renders filled -->
		<p class="same-render">
			<b>Run order changes this result.</b> Both ran on one server, and {o.earlier.toUpperCase()} kept {o.kept_mb} MB alive on every render.
			{o.earlier === 'a' ? 'B' : 'A'} ran {o.requests_between} requests later on that fuller heap (more garbage collection, slower allocation), so it
			reads slower than its code is. Restart the server between the two, or profile them in the other order, before trusting the difference.
		</p>
	{/if}

	{#if cmp.render_same}
		<!-- the ground truth: did the render get faster? When not, per-line moves are attribution -->
		<p class="same-render">
			<b>No real change in render time</b> ({fmt_ms(cmp.render_same.a_ms)} ms → {fmt_ms(cmp.render_same.b_ms)} ms, within the runs' own
			spread of {fmt_ms(cmp.render_same.noise_ms)} ms). V8 decides what to inline differently from run to run, so the same CPU time can be
			charged to a different line: the moves below are marked <i>shifted</i>, not fixed or worse. Waiting and memory keep their verdicts.
		</p>
	{/if}

	{#if cmp.fix_check && !cmp.render_same}
		{@const f = cmp.fix_check}
		<!-- did the fix pay: what the fixed patterns promised against the render's measured change -->
		<p class="fix-check {f.verdict}">
			<b>
				{#if f.verdict === 'as-expected'}The fix paid off as expected{:else if f.verdict === 'less'}The fix saved less than expected{:else}The fix saved more than expected{/if}
			</b>: the patterns that went away or shrank were expected to save about {fmt_ms(f.predicted_ms)} ms per render, and the median
			render got {f.measured_ms >= 0 ? `${fmt_ms(f.measured_ms)} ms faster` : `${fmt_ms(-f.measured_ms)} ms slower`}.
			{#if f.verdict === 'less' && f.skewed}
				Most likely the run order above, not the fix: B ran on the heap A filled, so it reads slower than its code is. Restart the server and profile B again first.
			{:else if f.skewed}
				B ran on the heap A filled (see above), so the real saving is likely larger still.
			{:else if f.verdict === 'less'}
				The time most likely moved: look for lines and patterns that got worse below, or a wait that grew. If nothing did, profile both again with more renders; the runs may just be noisy.
			{:else if f.verdict === 'more'}
				The change removed more than the patterns saw: a cost that sat under the reporting floor, or less garbage to collect.
			{/if}
		</p>
	{/if}

	{#if cmp.patterns?.length}
		<h2>Slow patterns <span class="hint" style="font-weight:400">(what the change fixed, and what it brought in)</span></h2>
		<table>
			<thead><tr><th><span class="sr-only">what</span></th><th>pattern</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr></thead>
			<tbody>
				{#each cmp.patterns as p (p.kind + '\0' + p.title)}
					<tr>
						<td class="status {p.status}">{p.status}</td>
						<td class="fn">{p.title}</td>
						<td class="num">{p.a_ms ? fmt_ms(p.a_ms) + ' ms' : '—'}</td>
						<td class="num">{p.b_ms ? fmt_ms(p.b_ms) + ' ms' : '—'}</td>
						<td class="num {cls(p.d_ms)}"><b>{sign(p.d_ms, 'ms')}</b>{#if p.wait}&nbsp;waiting{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if cmp.drill?.length}
		<h2>Where one render's time moved <span class="hint" style="font-weight:400">(the rows of the drill-down that changed, down to the call or line that did it; one render each side)</span></h2>
		<table>
			<thead><tr><th><span class="sr-only">what</span></th><th>where</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr></thead>
			<tbody>
				{#each cmp.drill as r, i (r.path.join('\0') + '\0' + i)}
					<tr>
						<td class="status {r.status}">{r.status}</td>
						<td class="fn">
							<span class="hint">{r.path.slice(0, -1).join(' › ')}{r.path.length > 1 ? ' › ' : ''}</span><b>{r.kind === 'line' ? (r.at ?? r.path[r.path.length - 1]) : r.path[r.path.length - 1]}</b>
							{#if r.at && r.kind !== 'line' && r.kind !== 'lane'}<div class="code">{r.at}</div>{/if}
						</td>
						<!-- ≤: that side only had an "N more" fold, so the row is at most that -->
						<td class="num">{r.upto === 'a' ? '≤ ' : ''}{r.a_ms ? fmt_ms(r.a_ms) + ' ms' : '—'}</td>
						<td class="num">{r.upto === 'b' ? '≤ ' : ''}{r.b_ms ? fmt_ms(r.b_ms) + ' ms' : '—'}</td>
						<td class="num {cls(r.d_ms)}"><b>{r.upto ? 'at least ' : ''}{sign(r.d_ms, 'ms')}</b></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if cmp.lines?.filter((l) => l.status !== 'same').length}
		<h2>The exact lines <span class="hint" style="font-weight:400">(your costliest lines, per render, matched by their code so an edit above them does not lose them)</span></h2>
		<table>
			<thead><tr><th><span class="sr-only">what</span></th><th>line</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th><th class="num">made A → B</th><th class="num">kept A → B</th></tr></thead>
			<tbody>
				{#each cmp.lines.filter((l) => l.status !== 'same') as l (l.file + '\0' + l.code + '\0' + l.line)}
					<tr>
						<td class="status {l.status}">{l.status}</td>
						<td class="fn"><code>{l.file}:{l.line}</code><div class="code">{l.code}</div></td>
						<td class="num">{l.a_ms ? fmt_ms(l.a_ms) + ' ms' : '—'}</td>
						<td class="num">{l.b_ms ? fmt_ms(l.b_ms) + ' ms' : '—'}</td>
						<td class="num {cls(l.d_ms)}"><b>{sign(l.d_ms, 'ms')}</b></td>
						<td class="num">{mb(l.a_bytes)} → {mb(l.b_bytes)}</td>
						<td class="num">{mb(l.a_kept)} → {mb(l.b_kept)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

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
				{#each fns as r (r.key ?? r.name + r.file + ':' + r.line)}
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
	.status {
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		color: var(--text-faint);
	}
	.status.fixed,
	.status.better {
		color: var(--good);
	}
	.status.new,
	.status.worse {
		color: var(--bad);
	}
	.status.shifted {
		color: var(--text-faint);
		font-style: italic;
	}
	.fix-check {
		margin: 12px 0;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-left: 3px solid var(--c-green, #4a9d6e);
		border-radius: 8px;
		background: var(--bg-panel);
		font-size: 13.5px;
		line-height: 1.5;
	}
	.fix-check.less {
		border-left-color: var(--c-amber, #d4a017);
	}
	.same-render {
		margin: 12px 0;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-panel);
		font-size: 13.5px;
		line-height: 1.5;
	}
	.code {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		color: var(--text-faint);
		white-space: pre-wrap;
		word-break: break-word;
		max-width: 520px;
	}
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
