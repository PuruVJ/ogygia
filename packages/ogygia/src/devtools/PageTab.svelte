<script>
	/**
	 * The Page tab: what the BROWSER saw of this visit — the profiler beacon's data, read live (no tag,
	 * no server; runtime/beacon.ts records it on a devtools build). The vitals rated, what the page
	 * found wrong (each finding names its islands: hover lights them up, click opens the island), a
	 * waterfall of every island's wake (module → turn → hydrate, against FCP / LCP / DCL / load), the
	 * files that blocked the first paint, and the bytes by type. The analysis is page-insights.ts.
	 */
	import { read_page, cpu_of } from './page.js';
	import { first_difference, rate } from './page-insights.js';
	import { beacon_record_cpu } from '../runtime/beacon.js';
	import { read_styles, scan_unscoped, styles_findings } from './styles.js';

	let { tick = 0, focus = $bindable(null), selected = $bindable(null) } = $props();

	// THE PAGE'S STYLES: read once the tab opens (selectors tried against the page, the build's
	// unscoped markers fetched from the cache), after each in-app navigation, and on "check again" —
	// not on every tick
	let styles = $state(/** @type {import('./styles.js').StylesReport | null} */ (null));
	let styles_busy = $state(false);
	async function check_styles() {
		styles_busy = true;
		try {
			const s = read_styles(document, { match: true });
			s.unscoped = await scan_unscoped(document);
			styles = s;
		} catch {
			styles = null;
		}
		styles_busy = false;
	}
	// again after an in-app navigation (a new page, new sheets): keyed on the navigation's time — a
	// number, so the ticks that rebuild the view do not re-run a check that queries every selector
	const nav_key = $derived(view?.nav?.t ?? 0);
	$effect(() => {
		nav_key;
		const id = setTimeout(check_styles, nav_key ? 400 : 60);
		return () => clearTimeout(id);
	});
	const findings = $derived.by(() => {
		if (!view) return [];
		const extra = styles ? styles_findings(styles).map((f) => ({ ...f, fps: /** @type {string[]} */ ([]) })) : [];
		// errors, then warnings, then notes: the report's own order (a stable sort keeps the rest)
		const order = /** @type {Record<string, number>} */ ({ error: 0, warn: 1, info: 2 });
		return [...view.report.findings, ...extra].sort((a, b) => order[a.severity] - order[b.severity]);
	});

	let wrapW = $state(560);
	let diff_fp = $state(/** @type {string | null} */ (null));
	const LABEL_W = 132;
	const trackW = $derived(Math.max(160, wrapW - LABEL_W - 70));

	const view = $derived.by(() => {
		tick;
		try {
			return read_page();
		} catch {
			return null;
		}
	});

	const axis = $derived.by(() => {
		if (!view) return null;
		const { report, page } = view;
		const nav = page.visit?.nav ?? {};
		const paints = page.visit?.paints ?? {};
		const lines = [
			{ k: 'FCP', t: paints.fcp, c: '#38bdf8' },
			{ k: 'LCP', t: paints.lcp, c: '#f472b6' },
			{ k: 'DCL', t: nav.dcl, c: '#94a3b8' },
			{ k: 'load', t: nav.load, c: '#64748b' }
		].filter((l) => typeof l.t === 'number' && l.t > 0);
		let end = 1;
		for (const r of report.rows) end = Math.max(end, r.done);
		for (const h of view.holes ?? []) end = Math.max(end, (h.shown_at ?? 0) + h.wait_ms);
		for (const l of lines) end = Math.max(end, l.t);
		end *= 1.04;
		const x = (/** @type {number} */ t) => Math.max(0, Math.min(trackW, (t / end) * trackW));
		return { end, lines, x };
	});

	/**
	 * A hole's bar, cut where the browser and the server timed it: before its request left (the page
	 * busy, the runtime's queue), the server's wait for a render slot, the server render, then the
	 * rest (network, the body, the swap). Without a timing, one segment: the wait.
	 * @param {import('./page-insights.js').HoleWait} h
	 */
	function hole_segs(h) {
		const shown = h.shown_at ?? 0;
		const at = shown + h.wait_ms;
		/** @type {{ k: string; a: number; b: number }[]} */
		const out = [];
		if (h.left_at === undefined) return [{ k: 'wait', a: shown, b: at }];
		const left = h.left_at;
		if (left > shown) out.push({ k: 'before', a: shown, b: left });
		let t = left;
		if (h.server_queue_ms) out.push({ k: 'slot', a: t, b: (t += h.server_queue_ms) });
		if (h.server_ms !== undefined) out.push({ k: 'render', a: t, b: (t += h.server_ms) });
		else if (h.first_at !== undefined) out.push({ k: 'server', a: t, b: (t = h.first_at) });
		if (at > t) out.push({ k: 'rest', a: t, b: at });
		return out;
	}
	const SEG_TITLE = /** @type {Record<string, string>} */ ({
		wait: 'waiting for its answer',
		before: 'before its request left',
		slot: 'waiting for a render slot on the server',
		render: 'the server render',
		server: 'waiting on the server',
		rest: 'network, the body and the swap'
	});

	const kb = (/** @type {number} */ n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
	const ms = (/** @type {number} */ n) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms');

	function el_of(/** @type {string} */ fp) {
		return document.querySelector(`ogygia-region[data-og-fp="${fp}"]`);
	}
	function light(/** @type {string[]} */ fps) {
		focus = fps.length ? el_of(fps[0]) : null;
	}
	function open(/** @type {string} */ fp) {
		const el = el_of(fp);
		if (el) selected = el;
	}
	// a hole has no fingerprint: its endpoint finds it
	function hole_el(/** @type {string | undefined} */ endpoint) {
		return endpoint ? document.querySelector(`ogygia-region[endpoint="${CSS.escape(endpoint)}"]`) : null;
	}
	function vital_text(v) {
		return v.key === 'cls' ? String(v.value) : ms(v.value);
	}
	// the server's own account of THIS document (its Server-Timing: ogygia's profiler sends it in dev)
	const doc_server = (() => {
		try {
			const nav = performance.getEntriesByType('navigation')[0];
			const st = nav?.serverTiming ?? [];
			const get = (n) => st.find((x) => x.name === n);
			const ssr = get('ssr');
			if (!ssr) return null;
			const net = get('net');
			const ups = ['up1', 'up2', 'up3'].map(get).filter(Boolean);
			return { ssr: ssr.duration, net: net?.duration ?? null, calls: net?.description ?? '', ups: ups.map((u) => ({ desc: u.description, ms: u.duration })) };
		} catch {
			return null;
		}
	})();
	// the document's vitals (after a navigation the report drops them; they still show, labelled)
	const LABEL = { ttfb: 'TTFB', fcp: 'FCP', lcp: 'LCP', cls: 'CLS', inp: 'INP' };
	const doc_vitals = $derived.by(() => {
		if (!view) return [];
		if (!view.nav) return view.report.vitals;
		const out = [];
		for (const key of ['ttfb', 'fcp', 'lcp', 'cls', 'inp']) {
			const v = view.page.vitals[key];
			if (typeof v === 'number') out.push({ key, label: LABEL[key], value: v, rating: rate(key, v) });
		}
		return out;
	});
	// ── the main thread (the browser's sampler): the load trace, or a recording made here ──
	let pick = $state(0);
	let recording = $state(false);
	const traces = $derived(view?.page.cpu.traces ?? []);
	const cpu = $derived.by(() => {
		const t = traces[Math.min(pick, traces.length - 1)];
		return t && view ? cpu_of(view.page, t.trace) : null;
	});
	async function record() {
		recording = true;
		try {
			await beacon_record_cpu(5000, `recording ${new Date().toLocaleTimeString()}`);
			pick = 0; // the newest
		} finally {
			recording = false;
		}
	}
	const KIND_COLOR = { app: '#22c55e', ogygia: '#14b8a6', svelte: '#f97316', dependency: '#a78bfa', 'page script': '#f472b6', browser: '#64748b', devtools: '#334155' };
	const diff = $derived.by(() => {
		if (!view || !diff_fp) return null;
		const s = view.page.snapshots.find((x) => x.fp === diff_fp);
		return s ? first_difference(s.ssr, s.hydrated, 120) : null;
	});
</script>

<div class="pg" bind:clientWidth={wrapW}>
	{#if !view}
		<p class="muted" data-og-page-unmeasured>
			This page load was not measured: in a build, devtools measures only for a browser that opened it
			before the page loaded (so other visitors pay nothing). <b>Reload</b> and it is measured from the start.
		</p>
	{:else}
		<div class="cap">page <span class="muted">· what the browser saw of this visit (dev server: modules load one by one, so load times run high)</span></div>

		{#if view.since && (view.since.fixed.length || view.since.added.length || view.since.moved.length)}
			{@const s = view.since}
			<!-- the dev loop: changed the code, reloaded — what changed on this page -->
			<div class="since" data-og-page-since>
				<b>Since your last load</b> <span class="muted">({ms(s.ago_ms)} ago)</span>
				{#if s.fixed.length}<p class="good">fixed: {s.fixed.join(' · ')}</p>{/if}
				{#if s.added.length}<p class="bad">new: {s.added.join(' · ')}</p>{/if}
				{#if s.moved.length}
					<p>
						{#each s.moved as m, i (m.what)}{i ? ' · ' : ''}<span class={m.better ? 'good' : 'bad'}>{m.what} {m.unit ? ms(m.a) : m.a} → {m.unit ? ms(m.b) : m.b}</span>{/each}
					</p>
				{/if}
			</div>
		{/if}

		{#if view.unmeasured.length}
			<p class="navnote" data-og-page-browser-limits>
				This browser does not report {view.unmeasured.join(', ')}. Findings that need them cannot appear here, so their
				absence is not a clean bill: check those in a Chromium browser.
			</p>
		{/if}

		{#if view.nav}
			<p class="navnote" data-og-page-nav>
				Since the in-app navigation to <code>{view.nav.to}</code> ({ms(performance.now() - view.nav.t)} ago): the findings and
				island rows below are this page's. The vitals are the first page's load (a navigation paints nothing the browser
				reports); record the main thread again to see this page's.
			</p>
		{/if}
		<div class="vitals" data-og-vitals>
			{#each doc_vitals as v (v.key)}
				<div class="vital {v.rating}" title="{v.label}: {v.rating === 'good' ? 'good' : v.rating === 'fair' ? 'needs work' : 'poor'}">
					<span class="k">{v.label}</span><span class="v">{vital_text(v)}</span>
				</div>
			{:else}
				<span class="muted">no vitals yet</span>
			{/each}
			{#if view.report.longtask_ms}
				<div class="vital neutral" title="main-thread time in tasks over 50 ms">
					<span class="k">long tasks</span><span class="v">{ms(view.report.longtask_ms)}</span>
				</div>
			{/if}
		</div>

		{#if doc_server}
			<p class="srvline" data-og-page-server>
				The server rendered this page in <b>{ms(doc_server.ssr)}</b>{#if doc_server.net !== null}, {ms(doc_server.net)} of it waiting on {doc_server.calls.split('(')[1]?.split(')')[0] ?? 'its'} outbound calls{#if doc_server.ups.length} — the slowest {doc_server.ups.map((u) => `${u.desc} ${ms(u.ms)}`).join(', ')}{/if}{/if}.
			</p>
		{/if}

		<h3>Findings <span class="muted">{findings.length || 'none'}</span></h3>
		{#if findings.length}
			<ul class="findings" data-og-page-findings>
				{#each findings as f, i (f.code + i)}
					<li
						class={f.severity}
						data-code={f.code}
						onmouseenter={() => light(f.fps)}
						onmouseleave={() => (focus = null)}
					>
						<p class="msg"><span class="sev">{f.severity}</span>{f.message}</p>
						{#if f.fix}<p class="fix">{f.fix}</p>{/if}
						{#if f.fps.length}
							<p class="acts">
								{#each f.fps.slice(0, 6) as fp (fp)}
									<button class="chip" onclick={() => open(fp)}>{view.regions.find((r) => r.fp === fp)?.name ?? fp.slice(0, 8)}</button>
								{/each}
								{#if f.code === 'markup-changed'}
									<button class="chip alt" onclick={() => (diff_fp = diff_fp === f.fps[0] ? null : f.fps[0])}>{diff_fp ? 'hide' : 'show'} difference</button>
								{/if}
							</p>
						{/if}
						{#if f.code === 'markup-changed' && diff && diff_fp === f.fps[0]}
							<div class="diff">
								<div><span class="lbl">server</span><code>{diff.server}</code></div>
								<div><span class="lbl">browser</span><code>{diff.now}</code></div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted ok">Nothing the browser measured looks wrong on this visit.</p>
		{/if}

		<!-- (a page with no islands — a Kit-hydrated one — has no wakes to show: no empty heading) -->
		{#if view.report.rows.length || view.kept?.length || view.regions.some((r) => r.kind === 'island')}
			<h3>Island wakes <span class="muted">{view.report.rows.length}{view.kept?.length ? ` · ${view.kept.length} kept` : ''}</span></h3>
		{/if}
		{#if view.kept?.length}
			<!-- the router reused them: the same island with the same props on both pages -->
			<p class="kept" data-og-page-kept>
				Kept from the page before, still awake (no code to load, no hydrate):
				{#each view.kept.slice(0, 12) as k, i (k.fp)}{i ? ', ' : ''}<button class="chip" onclick={() => open(k.fp)} onmouseenter={() => light([k.fp])} onmouseleave={() => (focus = null)}>{k.name}</button>{/each}{view.kept.length > 12 ? ` and ${view.kept.length - 12} more` : ''}.
			</p>
		{/if}
		{#if axis && view.report.rows.length}
			<div class="legend">
				<span><i class="sw load"></i>module</span>
				<span><i class="sw queue"></i>waiting for its turn</span>
				<span><i class="sw hyd"></i>hydrate</span>
				{#each axis.lines as l (l.k)}<span><i class="ln" style:background={l.c}></i>{l.k} {ms(l.t)}</span>{/each}
			</div>
			<div class="wf">
				{#each view.report.rows as r (r.fp)}
					{@const lo = r.queue_ms === null ? r.t0 + r.load_ms : r.t0 + r.load_ms + r.queue_ms}
					<div
						class="row"
						class:bad={r.recovered || r.changed || r.early_ms !== null || r.shift >= 0.01}
						role="button"
						tabindex="0"
						onmouseenter={() => light([r.fp])}
						onmouseleave={() => (focus = null)}
						onclick={() => open(r.fp)}
						onkeydown={(e) => e.key === 'Enter' && open(r.fp)}
					>
						<span class="name" style:width="{LABEL_W}px" title={r.name}>{r.name}<span class="wake">{r.wake}</span></span>
						<span class="track" style:width="{trackW}px">
							{#each axis.lines as l (l.k)}<i class="ln abs" style:left="{axis.x(l.t)}px" style:background={l.c}></i>{/each}
							<i class="seg load" style:left="{axis.x(r.t0)}px" style:width="{Math.max(1, axis.x(r.t0 + r.load_ms) - axis.x(r.t0))}px"></i>
							{#if r.queue_ms !== null}<i class="seg queue" style:left="{axis.x(r.t0 + r.load_ms)}px" style:width="{Math.max(0, axis.x(lo) - axis.x(r.t0 + r.load_ms))}px"></i>{/if}
							<i class="seg hyd" style:left="{axis.x(lo)}px" style:width="{Math.max(2, axis.x(r.done) - axis.x(lo))}px"></i>
						</span>
						<span class="t" title="module {r.load_ms} ms{r.queue_ms !== null ? ` · waited ${r.queue_ms} ms` : ''} · hydrate {r.hydrate_ms} ms">{ms(r.done)}</span>
						<span class="tags">
							{#if r.recovered}<b class="tag err">recovered</b>{/if}
							{#if r.changed && !r.recovered}<b class="tag warn">markup changed</b>{/if}
							{#if r.early_ms !== null}<b class="tag warn">clicked {Math.round(r.early_ms)} ms early</b>{/if}
							{#if r.shift >= 0.01}<b class="tag warn">CLS {r.shift}</b>{/if}
							{#if r.hydrate_ms >= 50}<b class="tag warn">{Math.round(r.hydrate_ms)} ms task</b>{/if}
							{#if r.cpu_ms && r.cpu_ms >= 20}<b class="tag info" title="main-thread CPU sampled in its hydrate window">{Math.round(r.cpu_ms)} ms CPU</b>{/if}
							{#if r.below_fold && (r.wake === 'load' || r.wake === 'idle')}<b class="tag info">below the fold</b>{/if}
						</span>
					</div>
				{/each}
			</div>
		{:else}
			<p class="muted">No island has woken yet.</p>
		{/if}

		{#if axis && (view.holes?.length || view.holes_failed?.length)}
			<!-- each hole's first answer: how long its fallback stood, and where that time went -->
			<h3>Hole answers <span class="muted">{view.holes?.length ?? 0}{view.holes_failed?.length ? ` · ${view.holes_failed.length} never came` : ''}</span></h3>
			<div class="legend">
				<span><i class="sw h-before"></i>before its request left</span>
				<span><i class="sw h-slot"></i>render slot</span>
				<span><i class="sw h-render"></i>server render</span>
				<span><i class="sw h-server"></i>waiting on the server</span>
				<span><i class="sw h-rest"></i>network + swap</span>
			</div>
			<div class="wf" data-og-page-holes>
				{#each view.holes_failed ?? [] as f, i (f.endpoint ?? i)}
					<!-- no answer: the fallback still stands; the Findings say why and where to look -->
					<div
						class="row bad"
						data-og-hole-failed
						role="button"
						tabindex="0"
						onmouseenter={() => (focus = hole_el(f.endpoint))}
						onmouseleave={() => (focus = null)}
						onclick={() => (selected = hole_el(f.endpoint) ?? selected)}
						onkeydown={(e) => e.key === 'Enter' && (selected = hole_el(f.endpoint) ?? selected)}
					>
						<span class="name" style:width="{LABEL_W}px" title={f.name}>{f.name}</span>
						<span class="track" style:width="{trackW}px"><i class="seg h-failed" style:left="0px" style:width="{trackW}px"></i></span>
						<span class="t">none</span>
						<span class="tags"><b class="tag err">{f.reason === 'error' ? `failed ${f.attempts}×${f.message ? ` (${f.message})` : ''}` : f.reason === 'redirected' ? 'redirected' : 'answered with a page'}</b></span>
					</div>
				{/each}
				{#each view.holes ?? [] as h, i (h.endpoint ?? i)}
					{@const segs = hole_segs(h)}
					<div
						class="row"
						class:bad={!h.below_fold && h.wait_ms >= 1000}
						role="button"
						tabindex="0"
						onmouseenter={() => (focus = hole_el(h.endpoint))}
						onmouseleave={() => (focus = null)}
						onclick={() => (selected = hole_el(h.endpoint) ?? selected)}
						onkeydown={(e) => e.key === 'Enter' && (selected = hole_el(h.endpoint) ?? selected)}
					>
						<span class="name" style:width="{LABEL_W}px" title={h.name}>{h.name}</span>
						<span class="track" style:width="{trackW}px">
							{#each axis.lines as l (l.k)}<i class="ln abs" style:left="{axis.x(l.t)}px" style:background={l.c}></i>{/each}
							{#each segs as s (s.k)}<i class="seg h-{s.k}" title="{SEG_TITLE[s.k]}: {ms(s.b - s.a)}" style:left="{axis.x(s.a)}px" style:width="{Math.max(1, axis.x(s.b) - axis.x(s.a))}px"></i>{/each}
						</span>
						<span class="t" title="its fallback stood this long{h.below_fold ? ' (below the first screen)' : ''}">{ms(h.wait_ms)}</span>
						<span class="tags">
							{#if h.server_queue_ms && h.server_queue_ms >= 200}<b class="tag warn">{ms(h.server_queue_ms)} for a slot</b>{/if}
							{#if h.below_fold}<b class="tag info">below the fold</b>{/if}
						</span>
					</div>
				{/each}
			</div>
		{/if}

		<h3>Main thread <span class="muted">{cpu ? `${ms(cpu.busy_ms)} busy in ${ms(cpu.window_ms)}` : ''}</span></h3>
		<div class="cpu" data-og-cpu>
			<div class="cpu-bar">
				{#if traces.length > 1}
					<select bind:value={pick} aria-label="which trace">
						{#each traces as t, i (t.from)}<option value={i}>{t.label}</option>{/each}
					</select>
				{:else if traces.length}
					<span class="muted">{traces[0].label}</span>
				{/if}
				<button class="chip alt" data-og-cpu-record disabled={recording || view.page.cpu.off === 'unsupported' || view.page.cpu.off === 'no-policy'} onclick={record}>
					{recording ? 'recording 5 s… use the page now' : 'record 5 s'}
				</button>
			</div>
			{#if !traces.length}
				<p class="muted">
					{view.page.cpu.state === 'recording'
						? 'Sampling the page load (8 s)…'
						: view.page.cpu.off === 'unsupported'
							? 'This browser has no JS sampler (the JS Self-Profiling API is Chromium-only).'
							: view.page.cpu.off === 'no-policy'
								? 'The browser would not sample this document: it needs the header Document-Policy: js-profiling (the devtools dev server sends it; a proxy may drop it).'
								: 'No trace yet.'}
				</p>
			{:else if cpu}
				<div class="kinds" title="where the busy time went">
					{#each cpu.by_kind as k (k.kind)}
						<i style:width="{(k.ms / Math.max(1, cpu.busy_ms)) * 100}%" style:background={KIND_COLOR[k.kind]} title="{k.kind} {ms(k.ms)}"></i>
					{/each}
				</div>
				<div class="legend">
					{#each cpu.by_kind as k (k.kind)}<span><i class="sw" style:background={KIND_COLOR[k.kind]}></i>{k.kind} {ms(k.ms)}</span>{/each}
				</div>
				<table data-og-cpu-fns>
					<thead><tr><th>function</th><th>where</th><th class="num">own</th><th class="num">with callees</th></tr></thead>
					<tbody>
						{#each cpu.fns.slice(0, 10) as f, i (f.name + f.file + f.line + i)}
							<tr>
								<td><i class="sw" style:background={KIND_COLOR[f.kind]}></i>{f.name}</td>
								<td class="url" title={f.file}>{f.file ? f.file.slice(f.file.lastIndexOf('/') + 1) : '—'}{f.line !== null ? `:${f.line}` : ''}</td>
								<td class="num">{ms(f.self_ms)}</td>
								<td class="num">{ms(f.total_ms)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="muted">Sampled every {cpu.interval_ms} ms by the browser: a function under ~{Math.round(cpu.interval_ms * 2)} ms may not show.</p>
			{/if}
		</div>

		{#if view.report.blocking.length}
			<h3>Blocked the first paint <span class="muted">{view.report.blocking.length}</span></h3>
			<table>
				<tbody>
					{#each view.report.blocking.slice(0, 8) as b, i (b.url + i)}
						<tr><td class="url" title={b.url}>{b.url.split('?')[0].split('/').pop() || b.url}</td><td class="num">{ms(b.ms)}</td><td class="num">{b.bytes ? kb(b.bytes) : ''}</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<h3>
			Styles
			<span class="muted">{styles ? `${styles.sheets.length} sheet${styles.sheets.length === 1 ? '' : 's'} · ${styles.rules} rules` : styles_busy ? 'reading…' : ''}</span>
			<button class="chip alt" onclick={check_styles} disabled={styles_busy} title="try every selector against the page as it is now (open a menu first to count its rules)">check again</button>
		</h3>
		{#if styles}
			{#if styles.unscoped.length}
				<p class="unscoped" data-og-page-unscoped>
					Unscoped: {#each styles.unscoped as u, i (u.file)}{i ? ', ' : ''}<code>{u.file}</code>{/each}. Their rules apply to every element on the page.
				</p>
			{/if}
			<table data-og-page-styles>
				<thead><tr><th>sheet</th><th class="num">rules</th><th class="num">match nothing</th><th class="num">size</th></tr></thead>
				<tbody>
					{#each styles.sheets.slice(0, 10) as s, i (s.label + i)}
						<tr>
							<td class="url" title={s.href ?? 'a style element in the document'}>{s.label}{#if s.blocking} <span class="tag">blocked paint</span>{/if}{#if s.ogygia} <span class="tag og">ogygia</span>{/if}</td>
							<td class="num">{s.rules}</td>
							<td class="num">{s.unmatched === null ? '—' : s.rules ? `${s.unmatched} (${Math.round((s.unmatched / s.rules) * 100)}%)` : '0'}</td>
							<td class="num">{s.bytes ? kb(s.bytes) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if styles.sheets.length > 10}<p class="muted">and {styles.sheets.length - 10} more sheets</p>{/if}
			{#if styles.examples.length}
				<p class="muted">Match nothing now, e.g. {#each styles.examples.slice(0, 4) as e, i (e)}{i ? ', ' : ''}<code>{e.length > 60 ? e.slice(0, 60) + '…' : e}</code>{/each}. Content that shows up later (menus, dialogs) counts here until it is open.</p>
			{/if}
			{#if styles.unreadable}<p class="muted">{styles.unreadable} sheet{styles.unreadable === 1 ? '' : 's'} from another origin could not be read.</p>{/if}
		{/if}

		{#if view.report.bytes.length}
			<h3>Files by type</h3>
			<table>
				<thead><tr><th>type</th><th class="num">files</th><th class="num">sent</th><th class="num">size</th></tr></thead>
				<tbody>
					{#each view.report.bytes as b (b.type)}
						<tr><td>{b.type}</td><td class="num">{b.count}</td><td class="num">{b.transfer ? kb(b.transfer) : '—'}</td><td class="num">{b.size ? kb(b.size) : '—'}</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
	{/if}
</div>

<style>
	.pg {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.cap {
		font-size: 12px;
		color: #5eead4;
	}
	.srvline {
		margin: 0;
		color: #cbd5e1;
		line-height: 1.5;
	}
	.srvline b {
		color: #5eead4;
	}
	.since {
		padding: 6px 9px;
		border-radius: 8px;
		background: rgba(56, 189, 248, 0.08);
		border: 1px solid rgba(56, 189, 248, 0.25);
	}
	.since p {
		margin: 3px 0 0;
	}
	.since .good {
		color: #4ade80;
	}
	.since .bad {
		color: #fca5a5;
	}
	.navnote {
		margin: 0;
		padding: 6px 9px;
		border-radius: 8px;
		background: rgba(236, 72, 153, 0.1);
		border: 1px solid rgba(236, 72, 153, 0.3);
		color: #fbcfe8;
		line-height: 1.5;
	}
	.navnote code {
		color: #f9a8d4;
	}
	.kept {
		margin: 0;
		color: #cbd5e1;
		line-height: 1.8;
	}
	.muted {
		color: #94a3b8;
	}
	.ok {
		color: #86efac;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 11px;
		color: #cbd5e1;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.vitals {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.vital {
		display: flex;
		flex-direction: column;
		padding: 5px 10px;
		border-radius: 8px;
		border: 1px solid rgba(148, 163, 184, 0.25);
		min-width: 64px;
	}
	.vital .k {
		color: #94a3b8;
		font-size: 10px;
	}
	.vital .v {
		font-size: 13px;
		font-weight: 700;
	}
	.vital.good {
		border-color: rgba(34, 197, 94, 0.5);
	}
	.vital.good .v {
		color: #4ade80;
	}
	.vital.fair {
		border-color: rgba(251, 191, 36, 0.5);
	}
	.vital.fair .v {
		color: #fbbf24;
	}
	.vital.poor {
		border-color: rgba(239, 68, 68, 0.55);
	}
	.vital.poor .v {
		color: #f87171;
	}
	.findings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.findings li {
		padding: 7px 9px;
		border-radius: 8px;
		border-left: 3px solid #64748b;
		background: rgba(148, 163, 184, 0.07);
	}
	.findings li.error {
		border-left-color: #ef4444;
	}
	.findings li.warn {
		border-left-color: #f59e0b;
	}
	.findings li.info {
		border-left-color: #38bdf8;
	}
	.msg,
	.fix,
	.acts {
		margin: 0;
		line-height: 1.5;
	}
	.fix {
		color: #94a3b8;
		margin-top: 3px;
	}
	.sev {
		display: inline-block;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #94a3b8;
		margin-right: 6px;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 5px;
	}
	.chip {
		font: inherit;
		font-size: 10px;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid rgba(94, 234, 212, 0.4);
		background: none;
		color: #5eead4;
		cursor: pointer;
	}
	.chip.alt {
		border-color: rgba(148, 163, 184, 0.35);
		color: #cbd5e1;
	}
	.diff {
		margin-top: 6px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.diff div {
		display: flex;
		gap: 6px;
	}
	.diff .lbl {
		width: 52px;
		flex: none;
		color: #94a3b8;
	}
	.diff code {
		white-space: pre-wrap;
		word-break: break-all;
		color: #e2e8f0;
		background: rgba(148, 163, 184, 0.1);
		padding: 2px 5px;
		border-radius: 4px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		color: #94a3b8;
		font-size: 10px;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 6px;
		border-radius: 2px;
	}
	.sw.load,
	.seg.load {
		background: #38bdf8;
	}
	.sw.queue,
	.seg.queue {
		background: repeating-linear-gradient(90deg, #475569 0 3px, transparent 3px 5px);
	}
	.sw.hyd,
	.seg.hyd {
		background: #22c55e;
	}
	/* a hole's answer: before it left, the server's slot wait, its render, the rest */
	.sw.h-before,
	.seg.h-before,
	.seg.h-wait {
		background: repeating-linear-gradient(90deg, #475569 0 3px, transparent 3px 5px);
	}
	.sw.h-slot,
	.seg.h-slot {
		background: #f59e0b;
	}
	.sw.h-render,
	.seg.h-render {
		background: #a78bfa;
	}
	.sw.h-server,
	.seg.h-server {
		background: #c4b5fd;
	}
	.sw.h-rest,
	.seg.h-rest {
		background: #7dd3fc;
	}
	.seg.h-failed {
		background: repeating-linear-gradient(90deg, rgba(248, 113, 113, 0.55) 0 4px, transparent 4px 8px);
	}
	.ln {
		display: inline-block;
		width: 2px;
		height: 10px;
	}
	.wf {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		padding: 1px 0;
		border-radius: 4px;
		flex-wrap: wrap;
	}
	.row:hover {
		background: rgba(148, 163, 184, 0.1);
	}
	.row.bad .name {
		color: #fbbf24;
	}
	.name {
		flex: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wake {
		color: #94a3b8;
		margin-left: 5px;
		font-size: 10px;
	}
	.track {
		position: relative;
		height: 12px;
		flex: none;
		background: rgba(148, 163, 184, 0.06);
		border-radius: 3px;
	}
	.seg {
		position: absolute;
		top: 2px;
		height: 8px;
		border-radius: 2px;
	}
	.ln.abs {
		position: absolute;
		top: 0;
		height: 12px;
		width: 1px;
		opacity: 0.8;
	}
	.t {
		width: 56px;
		text-align: right;
		color: #94a3b8;
		flex: none;
	}
	.tags {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		padding-left: 4px;
	}
	.tag {
		font-weight: 400;
		font-size: 10px;
		padding: 0 5px;
		border-radius: 4px;
	}
	.tag.err {
		background: rgba(239, 68, 68, 0.2);
		color: #fca5a5;
	}
	.tag.warn {
		background: rgba(245, 158, 11, 0.18);
		color: #fcd34d;
	}
	.tag.info {
		background: rgba(56, 189, 248, 0.15);
		color: #7dd3fc;
	}
	.tag.og {
		background: rgba(94, 234, 212, 0.14);
		color: #5eead4;
	}
	.url .tag {
		background: rgba(148, 163, 184, 0.16);
		color: #cbd5e1;
	}
	.url .tag.og {
		background: rgba(94, 234, 212, 0.14);
		color: #5eead4;
	}
	h3 .chip {
		margin-left: 6px;
		text-transform: none;
		letter-spacing: 0;
	}
	.unscoped {
		margin: 0;
		padding: 6px 9px;
		border-radius: 8px;
		background: rgba(245, 158, 11, 0.1);
		border: 1px solid rgba(245, 158, 11, 0.35);
		color: #fde68a;
	}
	.unscoped code {
		color: #fcd34d;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	.cpu {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.cpu-bar {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.cpu-bar select {
		background: #0d1526;
		color: #e2e8f0;
		border: 1px solid rgba(148, 163, 184, 0.25);
		border-radius: 6px;
		font: inherit;
		padding: 2px 5px;
	}
	.kinds {
		display: flex;
		height: 8px;
		border-radius: 4px;
		overflow: hidden;
		background: rgba(148, 163, 184, 0.1);
	}
	.kinds i {
		display: block;
		height: 100%;
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
	.num {
		text-align: right;
	}
	.url {
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
