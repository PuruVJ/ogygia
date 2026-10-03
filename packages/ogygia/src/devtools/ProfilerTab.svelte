<script>
	/**
	 * The Profiler tab — the SSR profiler, native in the dock (no iframe). "Profile this page" asks the
	 * profiler for its JSON answer (`/page?format=json`: the page rendered through the real server N
	 * times), keeps a slim copy (profile-store.ts) and renders it here: the score, the render time and
	 * what it would be after the fixes, the findings, every island's server cost joined to the island
	 * on THIS page (hover lights it up, click opens it — its detail card shows the same row), the
	 * heaviest components and the outbound calls. The full report is one click away. Dev-only, like
	 * the rest of devtools, so the profiler answers without a key.
	 */
	import { onMount } from 'svelte';
	import { run_profile, profile_for, profiles_version } from './profile-store.js';
	import { page_anchors } from './profile-anchors.js';
	import { highlight, clear_highlight } from './highlight.js';

	let { tick = 0, focus = $bindable(null), selected = $bindable(null) } = $props();

	const BASE = '/__profiler';
	let path = $state('/');
	let runs = $state(5);
	let available = $state(/** @type {boolean | null} */ (null)); // null = probing
	let running = $state(false);
	let started = $state(0);
	let error = $state('');
	let bump = $state(0); // a new profile landed

	onMount(() => {
		path = location.pathname;
		// Probe: a mounted profiler answers its base (200/redirect); an un-mounted one 404s.
		fetch(BASE, { method: 'GET', redirect: 'manual' })
			.then((r) => (available = r.status !== 404))
			.catch(() => (available = false));
		return () => clear_highlight(); // leaving the tab takes the boxes off the page
	});

	const prof = $derived.by(() => {
		tick;
		bump;
		profiles_version();
		return profile_for(path.startsWith('/') ? path : '/' + path);
	});
	const elapsed = $derived.by(() => {
		tick; // the panel's pulse moves the counter
		return running ? Math.max(0, (performance.now() - started) / 1000) : 0;
	});
	// a rough length for the next run, from the last one of this page (warm-up + the renders)
	const estimate = $derived(prof ? Math.round(((prof.render_ms * (runs + 1)) / 1000 + 2) * 1.3) : null);

	async function start() {
		error = '';
		running = true;
		started = performance.now();
		const p = path.startsWith('/') ? path : '/' + path;
		try {
			await run_profile(p, runs, BASE);
			bump++;
		} catch (e) {
			error = `The profile failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			running = false;
		}
	}

	const ms = (/** @type {number} */ n) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n >= 10 ? Math.round(n) + ' ms' : n.toFixed(1) + ' ms');
	const kb = (/** @type {number} */ n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
	function el_of(/** @type {string | null} */ fp) {
		return fp ? document.querySelector(`ogygia-region[data-og-fp="${fp}"]`) : null;
	}
	const on_page = $derived.by(() => {
		tick;
		const set = new Set();
		for (const el of document.querySelectorAll('ogygia-region[data-og-fp]')) set.add(el.getAttribute('data-og-fp'));
		return set;
	});
	function short_url(/** @type {string} */ u) {
		try {
			const x = new URL(u, location.href);
			return (x.host === location.host ? '' : x.host) + x.pathname;
		} catch {
			return u;
		}
	}
	const grade_class = (/** @type {number} */ s) => (s >= 80 ? 'good' : s >= 50 ? 'fair' : 'poor');

	// THE PROFILE ON THIS PAGE: costs with a place here (one DOM pass per profile, not per tick)
	const anchors = $derived.by(() => {
		if (!prof) return [];
		try {
			return page_anchors(prof);
		} catch {
			return [];
		}
	});
	let pinned = $state(/** @type {string | null} */ (null));
	function show(a, pin = false) {
		if (pin) pinned = pinned === a.key ? null : a.key;
		if (pin && pinned === null) return clear_highlight();
		highlight(a.find(), `${a.title} — ${a.detail}`, pin);
	}
	/** the islands on this page with these fingerprints (a browser finding's) */
	function regions_of(fps) {
		const want = new Set(fps);
		return [...document.querySelectorAll('ogygia-region[data-og-fp]')].filter((el) => want.has(el.getAttribute('data-og-fp')));
	}
	function unshow() {
		if (pinned) {
			const a = anchors.find((x) => x.key === pinned);
			if (a) return highlight(a.find(), `${a.title} — ${a.detail}`);
		}
		clear_highlight();
	}
</script>

<div class="pf" data-og-profiler>
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
			<button class="go" data-og-profile-run disabled={running} onclick={start}>
				{running ? `Profiling… ${elapsed.toFixed(0)} s${estimate ? ` of ~${estimate} s` : ''}` : prof ? 'Profile again' : 'Profile this page'}
			</button>
			{#if prof?.links}
				<a class="open" href={prof.links.html} target="_blank" rel="noopener" title="the full report, in a new tab">full report ↗</a>
			{/if}
		</div>
		{#if running}<div class="bar"><i style:width="{estimate ? Math.min(96, (elapsed / estimate) * 100) : 50}%"></i></div>{/if}
		{#if error}<p class="err">{error}</p>{/if}

		{#if !prof}
			<p class="hint">
				Renders <code>{path}</code> through your real server {runs}× and shows where the time went: components,
				functions, allocations, and outbound calls. The answer lands right here, and each island's server cost joins
				the island on the page.
			</p>
		{:else}
			<div class="head" data-og-profile-head>
				{#if prof.score}
					<div class="score {grade_class(prof.score.score)}" title="page score{prof.score.was ? ` (was ${prof.score.was.score})` : ''}">
						<b>{prof.score.grade}</b><span>{prof.score.score}{#if prof.score.was && prof.score.was.score !== prof.score.score} <i class={prof.score.score > prof.score.was.score ? 'up' : 'down'}>{prof.score.score > prof.score.was.score ? '▲' : '▼'}{Math.abs(prof.score.score - prof.score.was.score)}</i>{/if}</span>
					</div>
				{/if}
				<div class="stat"><span class="k">server render</span><span class="v">{ms(prof.render_ms)}</span><span class="s">median of {prof.runs.length}</span></div>
				{#if prof.forecast && prof.forecast.after_ms < prof.forecast.now_ms - 1}
					<div class="stat"><span class="k">after the fixes</span><span class="v ok">{ms(prof.forecast.after_ms)}</span><span class="s">−{ms(prof.forecast.now_ms - prof.forecast.after_ms)}</span></div>
				{/if}
				{#if prof.seed_bytes}
					<div class="stat"><span class="k">page seed</span><span class="v">{kb(prof.seed_bytes)}</span></div>
				{/if}
				<span class="when">{new Date(prof.at).toLocaleTimeString()}</span>
			</div>
			{#if prof.score}
				<div class="cats" data-og-profile-score>
					{#each prof.score.categories as c (c.key)}
						<span class="cat {grade_class(c.score)}" title="{c.value}{c.detail.length ? '\n' + c.detail.join('\n') : ''}">{c.label} <b>{c.score}</b>{#if c.lost >= 1}<i class="lost"> −{Math.round(c.lost)}</i>{/if}</span>
					{/each}
				</div>
				{#if prof.score.missing.length}
					<p class="hint">Left out of the score: {prof.score.missing.map((m) => m.label).join(', ')} — {prof.score.missing[0].why}.</p>
				{/if}
			{/if}

			{#if prof.assets}
				<h3>What the page loads <span class="muted">{kb(prof.assets.js)} JS at start · {kb(prof.assets.wire)} on the wire{prof.assets.lazy_js ? ` · ${kb(prof.assets.lazy_js)} on demand` : ''}</span></h3>
				<table data-og-profile-assets>
					<tbody>
						{#each prof.assets.files as f, i (f.name + i)}
							<tr class:lazyrow={f.lazy}>
								<td class="url" title={f.name}>{f.name}</td>
								<td class="muted">{f.kind}{f.lazy ? ' · on demand' : ''}</td>
								<td class="num">{kb(f.bytes)}</td>
								<td class="muted holds" title={f.contains.join(', ')}>{f.contains.join(', ')}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			{#if anchors.length}
				<h3>On this page <span class="muted">hover to light up, click to pin</span></h3>
				<ul class="anchors" data-og-profile-anchors>
					{#each anchors as a (a.key)}
						<li class:pinned={pinned === a.key}>
							<button
								data-anchor={a.key}
								onmouseenter={() => show(a)}
								onmouseleave={unshow}
								onclick={() => show(a, true)}
							>
								<b>{a.title}</b><span class="muted">{a.detail}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if prof.forecast?.parts.length}
				<h3>What the fixes save</h3>
				<ul class="parts">
					{#each prof.forecast.parts as p, i (p.kind + p.title + i)}
						<li><span class="pm">−{ms(p.ms)}</span>{p.title}{#if p.wait}<span class="tag">waiting</span>{/if}</li>
					{/each}
				</ul>
			{/if}

			{#if prof.hot.length}
				<h3>The server's hottest code <span class="muted">own time, per render</span></h3>
				<table data-og-profile-hot>
					<tbody>
						{#each prof.hot as f, i (f.name + i)}
							<tr><td>{f.name}</td><td class="muted">{f.file ? f.file.slice(f.file.lastIndexOf('/') + 1) : ''}{f.line !== null ? `:${f.line}` : ''}</td><td class="muted">{f.kind}</td><td class="num">{ms(f.ms)}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}

			{#if prof.findings.length}
				<h3>Findings <span class="muted">{prof.findings.length > 12 ? `12 of ${prof.findings.length}, the rest in the full report` : prof.findings.length}</span></h3>
				<ul class="findings" data-og-profile-findings>
					{#each prof.findings.slice(0, 12) as f, i (f.code + i)}
						<li
							class={f.severity}
							class:lit={!!f.fps}
							data-code={f.code}
							onmouseenter={f.fps ? () => highlight(regions_of(f.fps), f.code) : undefined}
							onmouseleave={f.fps ? unshow : undefined}
						>
							<p class="msg">{f.message}</p>
							{#if f.fix}<p class="fix">{f.fix}</p>{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if prof.islands.length}
				<h3>Islands on the server <span class="muted">{prof.islands.length}</span></h3>
				<table data-og-profile-islands>
					<thead><tr><th>island</th><th class="num">render</th><th class="num">props</th><th class="num">browser</th><th></th></tr></thead>
					<tbody>
						{#each prof.islands as i, k (i.fp ?? i.name + k)}
							{@const here = i.fp !== null && on_page.has(i.fp)}
							<tr
								class:here
								onmouseenter={() => (focus = el_of(i.fp))}
								onmouseleave={() => (focus = null)}
								onclick={() => {
									const el = el_of(i.fp);
									if (el) selected = el;
								}}
							>
								<td>{i.name}<span class="wake">{i.wake ?? ''}</span></td>
								<td class="num">{i.ssr_ms !== null ? ms(i.ssr_ms) : '—'}</td>
								<td class="num" title={i.culprit ? `not plain JSON: ${i.culprit}` : ''}>{i.props_bytes !== null ? kb(i.props_bytes) : '—'}{#if i.culprit}<span class="warn">*</span>{/if}</td>
								<td class="num">{i.client_p50_ms !== null ? ms(i.client_p50_ms) : '—'}{#if i.recovered}<span class="warn"> recovered</span>{/if}</td>
								<td class="muted">{here ? '' : 'not on this page now'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			{#if prof.components.length}
				<h3>Heaviest components</h3>
				<table>
					<thead><tr><th>component</th><th class="num">own</th><th class="num">with children</th><th class="num">×</th></tr></thead>
					<tbody>
						{#each prof.components.slice(0, 8) as c, i (c.name + c.file + i)}
							<tr><td title={c.file ?? ''}>{c.name}</td><td class="num">{ms(c.self_ms)}</td><td class="num">{ms(c.total_ms)}</td><td class="num">{c.instances ?? ''}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}

			{#if prof.network && prof.network.count}
				<h3>Outbound calls <span class="muted">{prof.network.count} · {ms(prof.network.total_ms)}{prof.network.sequential_ms ? ` · ${ms(prof.network.sequential_ms)} one after another` : ''}</span></h3>
				<table>
					<tbody>
						{#each prof.network.calls.slice(0, 10) as c, k (c.url + k)}
							<tr><td class="url" title={c.url}>{c.method} {short_url(c.url)}</td><td class="num">{c.status ?? ''}</td><td class="num">{ms(c.wait_ms)}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.pf {
		display: flex;
		flex-direction: column;
		gap: 8px;
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
		width: 13rem;
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
	.go:disabled {
		opacity: 0.8;
		cursor: progress;
	}
	.open {
		margin-left: auto;
		color: #94a3b8;
		text-decoration: none;
		border: 1px solid rgba(148, 163, 184, 0.3);
		border-radius: 7px;
		padding: 4px 9px;
	}
	.open:hover {
		color: #e2e8f0;
	}
	.bar {
		height: 4px;
		background: rgba(148, 163, 184, 0.15);
		border-radius: 2px;
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: #14b8a6;
		transition: width 0.6s linear;
	}
	.err {
		color: #fca5a5;
		margin: 0;
	}
	.hint,
	.muted {
		color: #94a3b8;
	}
	.hint {
		line-height: 1.6;
		max-width: 56ch;
	}
	code {
		color: #5eead4;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 11px;
		color: #cbd5e1;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.head {
		display: flex;
		align-items: stretch;
		gap: 8px;
		flex-wrap: wrap;
	}
	.score {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 54px;
		border-radius: 10px;
		border: 1px solid rgba(148, 163, 184, 0.3);
	}
	.score b {
		font-size: 18px;
	}
	.score span {
		font-size: 10px;
		color: #94a3b8;
	}
	.score.good b {
		color: #4ade80;
	}
	.score.fair b {
		color: #fbbf24;
	}
	.score.poor b {
		color: #f87171;
	}
	.stat {
		display: flex;
		flex-direction: column;
		padding: 5px 10px;
		border-radius: 8px;
		border: 1px solid rgba(148, 163, 184, 0.25);
	}
	.stat .k {
		font-size: 10px;
		color: #94a3b8;
	}
	.stat .v {
		font-size: 14px;
		font-weight: 700;
	}
	.stat .v.ok {
		color: #4ade80;
	}
	.stat .s {
		font-size: 10px;
		color: #94a3b8;
	}
	.when {
		margin-left: auto;
		align-self: flex-end;
		color: #94a3b8;
		font-size: 10px;
	}
	.cats {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.cat {
		font-size: 10px;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		color: #cbd5e1;
	}
	.cat.good b {
		color: #4ade80;
	}
	.cat .lost {
		color: #fbbf24;
		font-style: normal;
	}
	.score i {
		font-style: normal;
		font-size: 9px;
	}
	.score i.up {
		color: #4ade80;
	}
	.score i.down {
		color: #f87171;
	}
	.lazyrow td {
		opacity: 0.6;
	}
	.anchors {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.anchors button {
		width: 100%;
		display: flex;
		gap: 8px;
		align-items: baseline;
		text-align: left;
		font: inherit;
		color: #e2e8f0;
		background: rgba(148, 163, 184, 0.07);
		border: 1px solid transparent;
		border-radius: 7px;
		padding: 5px 8px;
		cursor: pointer;
	}
	.anchors button:hover,
	.anchors .pinned button {
		border-color: rgba(244, 114, 182, 0.55);
		background: rgba(244, 114, 182, 0.1);
	}
	.anchors b {
		font-weight: 600;
		white-space: nowrap;
	}
	.holds {
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cat.fair b {
		color: #fbbf24;
	}
	.cat.poor b {
		color: #f87171;
	}
	.parts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.pm {
		display: inline-block;
		width: 64px;
		color: #4ade80;
	}
	.tag {
		margin-left: 6px;
		font-size: 10px;
		color: #7dd3fc;
	}
	.findings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.findings li {
		padding: 6px 9px;
		border-radius: 8px;
		border-left: 3px solid #38bdf8;
		background: rgba(148, 163, 184, 0.07);
	}
	.findings li.warn {
		border-left-color: #f59e0b;
	}
	.findings li.error {
		border-left-color: #ef4444;
	}
	.findings li.lit {
		cursor: default;
	}
	.findings li.lit:hover {
		background: rgba(56, 189, 248, 0.12);
	}
	.msg,
	.fix {
		margin: 0;
		line-height: 1.5;
	}
	.fix {
		color: #94a3b8;
		margin-top: 3px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th {
		text-align: left;
		color: #94a3b8;
		font-weight: 600;
		border-bottom: 1px solid rgba(148, 163, 184, 0.2);
		padding: 3px 4px;
	}
	td {
		padding: 2px 4px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.08);
	}
	tbody tr.here {
		cursor: pointer;
	}
	tbody tr.here:hover {
		background: rgba(148, 163, 184, 0.1);
	}
	.num {
		text-align: right;
		white-space: nowrap;
	}
	.wake {
		color: #94a3b8;
		margin-left: 5px;
		font-size: 10px;
	}
	.warn {
		color: #fbbf24;
	}
	.url {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
</style>
