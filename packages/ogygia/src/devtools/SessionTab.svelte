<script module>
	/** the last session's data + report, kept across tab switches (not across reloads) */
	let last = $state(/** @type {{ data: import('./session.js').SessionData; report: import('./session-insights.js').SessionReport } | null} */ (null));
</script>

<script>
	/**
	 * The Record tab: press record, use the page (click, type, scroll, navigate), press stop — and get
	 * what that stretch did: slow interactions (with the function behind each), clicks that did
	 * nothing or were repeated in frustration, long tasks, shifts nobody caused, failed / slow /
	 * repeated requests, islands that woke or broke, errors, DOM churn per island, heap growth,
	 * navigations. Every finding points at its elements: hover lights them up, click scrolls there.
	 * Engine: session.ts; analysis: session-insights.ts.
	 */
	import { onMount } from 'svelte';
	import { start_session, recording, set_last_session, session_names } from './session.js';
	import { run_profile, slim_profile } from './profile-store.js';
	import { analyze_session, session_timeline } from './session-insights.js';
	import { region_name_by_fp } from './regions.js';
	import { unmeasured } from './page.js';
	// (what this browser cannot measure: a session's silence on those is not a clean bill)
	const limits = unmeasured(typeof Profiler === 'undefined' ? 'unsupported' : null);
	import { highlight, clear_highlight } from './highlight.js';

	let { tick = 0 } = $props();

	let rec = $state(recording());
	let busy = $state(false);
	// (a session the page before was recording resumes at boot, maybe after this tab mounted: the
	// panel's pulse picks it up)
	const live = $derived.by(() => {
		tick;
		return rec ?? recording();
	});
	const elapsed = $derived.by(() => {
		tick;
		return live ? (performance.now() - live.started) / 1000 : 0;
	});

	// THE SERVER TOO: a profiler window over the same stretch (when the profiler is mounted)
	let profiler_here = $state(false);
	let with_server = $state(true);
	let server_note = $state('');
	let server_window = $state(/** @type {import('./profile-store.js').SlimProfile & { window?: any } | null} */ (null));
	/** @type {Promise<boolean> | null} */
	let probe = null;
	const probe_profiler = () =>
		(probe ??= fetch('/__profiler', { redirect: 'manual' })
			.then((r) => (profiler_here = r.status !== 404))
			.catch(() => (profiler_here = false)));
	onMount(() => void probe_profiler());
	let window_on = false;
	/** the window's start in flight (a stop pressed before it answered waits, then stops it) */
	let window_starting = /** @type {Promise<void> | null} */ (null);
	/** '' | 'starting' | 'on' | 'off' — shown beside the recording (the server may wait out a background sample) */
	let window_state = $state('');
	function start() {
		last = null;
		server_window = null;
		server_note = '';
		clear_highlight();
		window_on = false;
		// the browser side at once (the next click counts); the server window alongside
		rec = start_session();
		window_state = '';
		if (!with_server) return;
		window_state = 'starting';
		window_starting = (async () => {
			if (!(await probe_profiler())) return void (window_state = '');
			try {
				const r = await fetch('/__profiler/window/start', { method: 'POST' });
				window_on = r.ok;
				window_state = r.ok ? 'on' : 'off';
				if (!r.ok) server_note = `The server window did not start (${r.status}): ${(await r.text()).slice(0, 120)}`;
			} catch (e) {
				window_state = 'off';
				server_note = `The server window did not start: ${e instanceof Error ? e.message : String(e)}`;
			}
		})();
	}
	async function stop() {
		const r0 = rec ?? recording();
		if (!r0) return;
		busy = true;
		try {
			const resumed = !rec;
			const data = await r0.stop();
			rec = null;
			if (window_starting) await window_starting;
			window_starting = null;
			// a resumed session's window was started by the page before: stop it too (a 400 = none)
			if (window_on || (resumed && with_server && (await probe_profiler()))) {
				window_on = false;
				try {
					const r = await fetch('/__profiler/window/stop', { method: 'POST' });
					if (r.ok) {
						const json = await r.json();
						server_window = { ...slim_profile(json), window: json.window };
					} else if (!(resumed && r.status === 400)) server_note = `The server window failed (${r.status}).`;
				} catch (e) {
					server_note = `The server window failed: ${e instanceof Error ? e.message : String(e)}`;
				}
			}
			last = { data, report: analyze_session(data, session_names(data, (fp) => region_name_by_fp(fp)), location.href) };
			// (the answer key and e2e read the same report the tab shows; every tab reads the session)
			window.__ogygia_session = last.report;
			set_last_session(last);
			server = {};
		} finally {
			busy = false;
		}
	}

	/** the elements a finding's refs point at, now */
	function els_of(refs) {
		if (!last) return [];
		const out = [];
		for (const r of refs) {
			let el = null;
			if (r.kind === 'interaction') el = last.data.interactions[r.i]?.el?.deref() ?? null;
			else if (r.kind === 'click') el = last.data.clicks[r.i]?.el?.deref() ?? null;
			else if (r.kind === 'shift') el = last.data.shifts[r.i]?.el?.deref() ?? null;
			else if (r.kind === 'island') el = document.querySelector(`ogygia-region[data-og-fp="${r.fp}"]`);
			if (el && el.isConnected) out.push(el);
		}
		return out;
	}
	// THE SESSION ON ONE CLOCK: lanes of what happened, the requests split into server / upstream
	let tlW = $state(520);
	let hover = $state('');
	const tl = $derived.by(() => {
		if (!last) return null;
		const lanes = session_timeline(last.data, session_names(last.data, (fp) => region_name_by_fp(fp)));
		const span = Math.max(1, last.data.to - last.data.from);
		return { lanes, span };
	});
	const LANE_W = 88;
	const x_of = (t, span) => Math.max(0, Math.min(1, t / span)) * Math.max(100, tlW - LANE_W - 8);
	function tl_enter(it) {
		hover = it.label;
		if (it.ref) {
			const els = els_of([it.ref]);
			if (els.length) highlight(els, it.label.slice(0, 80));
		}
	}
	function tl_leave() {
		hover = '';
		clear_highlight();
	}

	// CLIENT → SERVER in one click: a slow request found in the session, profiled on the server
	let server = $state(/** @type {Record<string, { busy?: boolean; error?: string; p?: import('./profile-store.js').SlimProfile }>} */ ({}));
	async function profile_request(url) {
		const u = new URL(url);
		const path = u.pathname + u.search;
		server = { ...server, [url]: { busy: true } };
		try {
			const p = await run_profile(path, 3);
			server = { ...server, [url]: { p } };
		} catch (e) {
			server = { ...server, [url]: { error: e instanceof Error ? e.message : String(e) } };
		}
	}
	const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms');
	const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

	onMount(() => () => clear_highlight());
</script>

<div class="rec" data-og-session>
	<div class="bar">
		{#if live}
			<button class="stop" data-og-session-stop disabled={busy} onclick={stop}>■ Stop</button>
			<span class="live"><i class="dot"></i>recording {elapsed.toFixed(0)} s — use the page: click, type, scroll, navigate</span>
			{#if window_state}<span class="muted" data-og-session-server-state={window_state}>· server {window_state === 'on' ? 'too' : window_state === 'starting' ? 'starting…' : 'not recorded'}</span>{/if}
		{:else}
			<button class="go" data-og-session-start onclick={start}>● Record</button>
			{#if profiler_here}<label class="srvtoggle"><input type="checkbox" bind:checked={with_server} data-og-session-server-toggle /> and the server</label>{/if}
			<span class="muted">{last ? `last session: ${ms(last.report.duration_ms)}` : 'Press record, use the page, press stop.'}</span>
		{/if}
	</div>
	{#if limits.length}
		<p class="muted" data-og-session-browser-limits>
			This browser does not report {limits.join(', ')}: a session here cannot find what needs them. Record in a Chromium browser for those.
		</p>
	{/if}

	{#if last && !live}
		{@const r = last.report}
		<div class="stats">
			<div><b>{r.counts.interactions}</b><span>interactions{r.counts.slow ? ` · ${r.counts.slow} slow` : ''}</span></div>
			<div><b>{ms(r.counts.longtask_ms)}</b><span>{r.counts.longtasks} long tasks</span></div>
			<div><b>{r.counts.requests}</b><span>requests · {kb(r.counts.request_bytes)}</span></div>
			<div><b>{r.counts.shifts}</b><span>shifts by themselves</span></div>
			<div><b>{r.counts.mutations}</b><span>DOM changes</span></div>
			<div class:bad={r.counts.errors > 0}><b>{r.counts.errors}</b><span>errors</span></div>
		</div>

		{#if server_note}<p class="fix">{server_note}</p>{/if}
		{#if server_window}
			{@const sw = server_window}
			{@const hot = sw.hot.filter((h) => h.ms >= 1)}
			<h3>On the server, meanwhile <span class="muted">{sw.window?.requests?.length ?? 0} requests · the profiler's window</span></h3>
			<div class="srvprof" data-og-session-window>
				{#if sw.window?.requests?.length}
					<table>
						<tbody>
							{#each sw.window.requests.slice(0, 8) as q, i (q.path + i)}
								<tr><td class="tgt">{q.method} {q.path}{#if q.route}<span class="muted"> · {q.route}</span>{/if}</td><td class="num">{ms(q.ms)}</td><td class="num">{q.status ?? ''}</td></tr>
							{/each}
						</tbody>
					</table>
				{/if}
				{#if hot.length}
					<p class="muted">the server's hottest code across them (own time):</p>
					<ul>{#each hot.slice(0, 5) as h, k (k)}<li>{h.name} <span class="muted">{h.file ? h.file.slice(h.file.lastIndexOf('/') + 1) : ''}{h.line !== null ? `:${h.line}` : ''} · {h.kind}</span> {ms(h.ms)}</li>{/each}</ul>
				{/if}
				{#if sw.network?.calls.length}
					<p class="muted">outbound calls:</p>
					<ul>{#each [...sw.network.calls].sort((a, b) => b.wait_ms - a.wait_ms).slice(0, 4) as c, k (k)}<li>{c.method} {c.url.split('?')[0]} {ms(c.wait_ms)}</li>{/each}</ul>
				{/if}
				{#each sw.findings.filter((x) => x.severity !== 'info').slice(0, 3) as x, k (k)}<p class="fix">{x.message}</p>{/each}
				{#if sw.links}<a class="full" href={sw.links.html} target="_blank" rel="noopener">full server report ↗</a>{/if}
			</div>
		{/if}

		{#if tl && tl.lanes.length}
			<h3>Timeline <span class="muted">{ms(tl.span)} · hover for what it was</span></h3>
			<div class="tl" data-og-session-timeline bind:clientWidth={tlW}>
				{#each tl.lanes as lane (lane.key)}
					<div class="lane">
						<span class="ll" style:width="{LANE_W}px">{lane.label}</span>
						<span class="track">
							{#each lane.items as it, i (i)}
								{@const x0 = x_of(it.t0, tl.span)}
								{@const w = Math.max(3, x_of(it.t1, tl.span) - x0)}
								<i
									class="it {it.tone}"
									class:point={it.t1 - it.t0 < 1}
									style:left="{x0}px"
									style:width="{w}px"
									role="presentation"
									onmouseenter={() => tl_enter(it)}
									onmouseleave={tl_leave}
								>
									{#if it.server}
										{@const total = Math.max(1, it.t1 - it.t0)}
										<b class="srvpart" style:width="{Math.min(100, (it.server.ms / total) * 100)}%"><b class="uppart" style:width="{it.server.ms ? Math.min(100, (it.server.up / it.server.ms) * 100) : 0}%"></b></b>
									{/if}
								</i>
							{/each}
						</span>
					</div>
				{/each}
				<p class="tlhover">{hover || ' '}</p>
			</div>
		{/if}

		<h3>Findings <span class="muted">{r.findings.length || 'none'}</span></h3>
		{#if r.findings.length}
			<ul class="findings" data-og-session-findings>
				{#each r.findings as f, i (f.code + i)}
					<li
						class={f.severity}
						data-code={f.code}
						onmouseenter={() => f.refs.length && highlight(els_of(f.refs), f.message.slice(0, 80))}
						onmouseleave={() => clear_highlight()}
					>
						<p class="msg">{f.message}</p>
						{#if f.fix}<p class="fix">{f.fix}</p>{/if}
						{#if f.refs.length && els_of(f.refs).length}
							<button class="chip" onclick={() => highlight(els_of(f.refs), f.message.slice(0, 80), true)}>show on the page ({els_of(f.refs).length})</button>
						{/if}
						{#if f.url}
							{@const sv = server[f.url]}
							<button class="chip srv" data-og-session-profile disabled={sv?.busy} onclick={() => profile_request(f.url)}>
								{sv?.busy ? 'profiling on the server…' : sv?.p ? 'profile again' : 'profile it on the server'}
							</button>
							{#if sv?.error}<p class="fix">{sv.error}</p>{/if}
							{#if sv?.p}
								{@const p = sv.p}
								{@const hot = p.hot.filter((h) => h.ms >= 1)}
								<div class="srvprof" data-og-session-server>
									<p><b>{ms(p.render_ms)}</b> per render on the server{#if p.forecast && p.forecast.after_ms < p.forecast.now_ms - 1}, <b class="ok">{ms(p.forecast.after_ms)}</b> after its fixes{/if}.</p>
									{#if hot.length}
										<p class="muted">hottest code:</p>
										<ul>
											{#each hot.slice(0, 3) as h, k (k)}<li>{h.name} <span class="muted">{h.file ? h.file.slice(h.file.lastIndexOf('/') + 1) : ''}{h.line !== null ? `:${h.line}` : ''}</span> {ms(h.ms)}</li>{/each}
										</ul>
									{:else}
										<p class="muted">Almost no CPU: the server spent the time waiting.</p>
									{/if}
									{#if p.network?.calls.length}
										<p class="muted">waited on:</p>
										<ul>
											{#each [...p.network.calls].sort((a, b) => b.wait_ms - a.wait_ms).slice(0, 3) as c, k (k)}<li>{c.method} {c.url.split('?')[0]} {ms(c.wait_ms)}</li>{/each}
										</ul>
									{/if}
									{#each p.findings.filter((x) => x.severity !== 'info').slice(0, 2) as x, k (k)}<p class="fix">{x.message}</p>{/each}
									{#if p.links}<a class="full" href={p.links.html} target="_blank" rel="noopener">full report ↗</a>{/if}
								</div>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted ok">Nothing in this session looks wrong.</p>
		{/if}

		{#if r.interactions.length}
			<h3>Slowest interactions</h3>
			<table>
				<tbody>
					{#each r.interactions as x (x.i)}
						<tr onmouseenter={() => highlight(els_of([{ kind: 'interaction', i: x.i }]), x.target)} onmouseleave={() => clear_highlight()}>
							<td>{x.name}</td>
							<td class="tgt" title={x.target}>{x.target}{#if x.fp}<span class="muted"> · {last?.data.names?.[x.fp] || region_name_by_fp(x.fp)}</span>{/if}</td>
							<td class="num" class:warnc={x.duration >= 200}>{ms(x.duration)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if r.requests.length}
			<h3>Requests <span class="muted">slowest first · the server's own split where it sent one</span></h3>
			<table data-og-session-requests>
				<tbody>
					{#each r.requests as q, i (q.url + i)}
						<tr>
							<td class="tgt" title={q.url}>{q.url}{#if q.status && q.status >= 400}<span class="warnc"> {q.status}</span>{/if}</td>
							<td class="num">{ms(q.ms)}</td>
							<td class="split">
								{#if q.server_ms !== null}
									{@const w = Math.max(q.ms, q.server_ms, 1)}
									<span class="bar" title="server {ms(q.server_ms)}{q.net_ms !== null ? ` (waiting on calls ${ms(q.net_ms)})` : ''} · network {ms(Math.max(0, q.ms - q.server_ms))}">
										<i class="srv" style:width="{((q.server_ms - (q.net_ms ?? 0)) / w) * 100}%"></i>{#if q.net_ms}<i class="up" style:width="{(q.net_ms / w) * 100}%"></i>{/if}<i class="netw" style:width="{(Math.max(0, q.ms - q.server_ms) / w) * 100}%"></i>
									</span>
									<span class="muted">{ms(q.server_ms)} server{q.up ? ` · ${q.up}` : ''}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if r.cpu}
			<h3>Main thread in the session <span class="muted">{ms(r.cpu.busy_ms)} busy</span></h3>
			<table>
				<tbody>
					{#each r.cpu.fns.slice(0, 8) as f, i (f.name + f.file + i)}
						<tr><td>{f.name}</td><td class="tgt">{f.file ? f.file.slice(f.file.lastIndexOf('/') + 1) : ''}{f.line !== null ? `:${f.line}` : ''}</td><td class="num">{ms(f.self_ms)}</td></tr>
					{/each}
				</tbody>
			</table>
		{:else if last.data.cpu_off}
			<p class="muted">No CPU samples: {last.data.cpu_off === 'no-policy' ? 'the document needs the Document-Policy: js-profiling header (the dev server sends it), or another recording held the sampler' : 'this browser has no JS sampler'}. Long animation frames still name the scripts where the browser supports them.</p>
		{/if}
	{/if}
</div>

<style>
	.rec {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.go,
	.stop {
		padding: 6px 14px;
		border-radius: 8px;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.go {
		border: 1px solid #be185d;
		background: #db2777;
		color: #fff;
	}
	.stop {
		border: 1px solid rgba(148, 163, 184, 0.4);
		background: #0d1526;
		color: #fca5a5;
	}
	.live {
		color: #fbcfe8;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #ef4444;
		animation: pulse 1s infinite alternate;
	}
	@keyframes pulse {
		to {
			opacity: 0.3;
		}
	}
	.muted {
		color: #94a3b8;
	}
	.ok {
		color: #86efac;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}
	.stats div {
		display: flex;
		flex-direction: column;
		padding: 5px 9px;
		border: 1px solid rgba(148, 163, 184, 0.22);
		border-radius: 8px;
	}
	.stats b {
		font-size: 14px;
	}
	.stats span {
		color: #94a3b8;
		font-size: 10px;
	}
	.stats .bad b {
		color: #f87171;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 11px;
		color: #cbd5e1;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.findings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.findings > li {
		padding: 7px 9px;
		border-radius: 8px;
		border-left: 3px solid #38bdf8;
		background: rgba(148, 163, 184, 0.07);
	}
	.findings > li.warn {
		border-left-color: #f59e0b;
	}
	.findings > li.error {
		border-left-color: #ef4444;
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
	.chip {
		margin-top: 5px;
		font: inherit;
		font-size: 10px;
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid rgba(244, 114, 182, 0.5);
		background: none;
		color: #f9a8d4;
		cursor: pointer;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	td {
		padding: 2px 4px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.08);
	}
	tr:hover td {
		background: rgba(148, 163, 184, 0.08);
	}
	.tgt {
		max-width: 260px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.num {
		text-align: right;
		white-space: nowrap;
	}
	.warnc {
		color: #fbbf24;
	}
	.srvtoggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: #94a3b8;
	}
	.tl {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.lane {
		display: flex;
		align-items: center;
	}
	.ll {
		flex: none;
		color: #94a3b8;
		font-size: 10px;
	}
	.lane .track {
		position: relative;
		flex: 1;
		height: 12px;
		background: rgba(148, 163, 184, 0.06);
		border-radius: 3px;
	}
	.it {
		position: absolute;
		top: 2px;
		height: 8px;
		border-radius: 2px;
		display: block;
		overflow: hidden;
		cursor: default;
	}
	.it.point {
		top: 0;
		height: 12px;
		width: 3px !important;
	}
	.it.ok {
		background: #22c55e;
	}
	.it.info {
		background: #38bdf8;
	}
	.it.warn {
		background: #f59e0b;
	}
	.it.bad {
		background: #ef4444;
	}
	.srvpart {
		display: block;
		height: 100%;
		background: #14b8a6;
	}
	.uppart {
		display: block;
		height: 100%;
		background: #a78bfa;
	}
	.tlhover {
		margin: 2px 0 0;
		min-height: 1.4em;
		color: #e2e8f0;
		font-size: 10.5px;
	}
	.chip.srv {
		margin-left: 4px;
		border-color: rgba(20, 184, 166, 0.55);
		color: #5eead4;
	}
	.srvprof {
		margin-top: 6px;
		padding: 6px 9px;
		border-radius: 7px;
		background: rgba(20, 184, 166, 0.08);
		border: 1px solid rgba(20, 184, 166, 0.25);
	}
	.srvprof p {
		margin: 2px 0;
	}
	.srvprof ul {
		margin: 0 0 4px;
		padding-left: 16px;
	}
	.srvprof b {
		color: #5eead4;
	}
	.srvprof b.ok {
		color: #4ade80;
	}
	.full {
		color: #94a3b8;
		font-size: 10px;
	}
	.split {
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.bar {
		display: inline-flex;
		width: 90px;
		height: 7px;
		border-radius: 3px;
		overflow: hidden;
		background: rgba(148, 163, 184, 0.1);
		flex: none;
	}
	.bar i {
		display: block;
		height: 100%;
	}
	.bar .srv {
		background: #14b8a6;
	}
	.bar .up {
		background: #a78bfa;
	}
	.bar .netw {
		background: #475569;
	}
</style>
