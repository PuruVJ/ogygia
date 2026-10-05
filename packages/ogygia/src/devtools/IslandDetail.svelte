<!-- (its CSS injected into the dock's shadow root: see Devtools.svelte) -->
<svelte:options css="injected" />

<script>
	/**
	 * The per-island detail view — "inspect element" for an ogygia region. Selecting a region (a Lens
	 * roster row, or picking it on the page) opens this over the tab body: one focused card that pulls
	 * together what the separate tabs each show a slice of — the region's identity, its full cost
	 * breakdown (JS-with-deps / entry chunk / props / server HTML), and its client LIFECYCLE as a
	 * mini-timeline (connected → scheduled → woke → hydrate → done, with per-phase offsets). A pure
	 * consumer of the DOM + bus, keyed by the selected `<ogygia-region>` element.
	 */
	import { parse } from 'devalue';
	import { onDestroy } from 'svelte';
	import { highlight, clear_highlight } from './highlight.js';
	import {
		region_info,
		region_name,
		region_transitive,
		chunk_bytes,
		latest_event,
		region_props_sidecar
	} from './regions.js';
	import { snapshot } from './bus.js';
	import { read_page } from './page.js';
	import { profile_for, profiles_version, island_row } from './profile-store.js';
	import { get_last_session, last_session_version } from './session.js';
	import PropsTree from './PropsTree.svelte';
	import { island_ledger } from './ledger-dom.js';

	let { el, tick = 0, onclose } = $props();

	const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');

	// Every transportable crosses under ONE devalue custom type ('OgygiaRef'). Decode it to a labelled
	// placeholder — NOT the live instance (`wire.resolve` has side effects) — so the viewer stays inert.
	const REVIVERS = {
		OgygiaRef: (d) => ({ __ogRef: true, kind: d && d.k, id: d && d.i, tag: d && d.t }),
		// A seed reference (seed-refs.ts): shown as the path it points at, not resolved — inert.
		OgygiaSeedRef: (p) => ({ __ogSeedRef: true, path: Array.isArray(p) ? p.join('.') : String(p) })
	};
	function decode_props(text) {
		if (!text || text.length < 3) return null;
		try {
			const v = parse(text, REVIVERS);
			return v && typeof v === 'object' && Object.keys(v).length ? v : null;
		} catch {
			return null;
		}
	}

	// Client lifecycle phases, in order, with the Timeline's colours.
	const PHASES = [
		{ name: 'region.connected', label: 'connected', c: '#64748b' },
		{ name: 'wake.scheduled', label: 'scheduled', c: '#38bdf8' },
		{ name: 'wake.fired', label: 'woke', c: '#2dd4bf' },
		{ name: 'region.hydrate.start', label: 'hydrate', c: '#f59e0b' },
		{ name: 'region.hydrate.done', label: 'done', c: '#22c55e' },
		{ name: 'interaction.replay', label: 'replay', c: '#8b5cf6' }
	];

	// its line of the exact byte ledger (a build: the page's island graph × the browser's sizes)
	// the modules in this island's files that the page also loads in another file (the last profile's
	// list, matched to its files by path): which copy is its, and what the second costs
	const twice_here = $derived.by(() => {
		profiles_version();
		const urls = ledger?.row.urls ?? [];
		const list = profile_for(location.pathname)?.assets?.twice ?? [];
		if (!urls.length || !list.length) return [];
		const paths = urls.map((u) => {
			try {
				return new URL(u).pathname;
			} catch {
				return u;
			}
		});
		const out = [];
		for (const d of list) {
			const mine = d.copies.find((c) => paths.some((p) => p.endsWith(c.file)));
			if (mine) out.push({ name: d.name, extra: d.extra, mine });
		}
		return out;
	});
	const ledger = $derived.by(() => {
		tick;
		return island_ledger(el?.getAttribute('entry'));
	});

	const model = $derived.by(() => {
		tick;
		const info = region_info(el);
		const t = region_transitive(info.entry);
		const chunk = info.entry ? chunk_bytes(info.entry) : null;
		const ev = snapshot();
		const rendered = info.fp
			? latest_event((e) => e.name === 'server.region.rendered' && e.fp === info.fp)
			: null;
		const marks = [];
		for (const ph of PHASES) {
			const e = ev.find((x) => x.name === ph.name && x.fp === info.fp);
			if (e) marks.push({ ...ph, t: e.t });
		}
		marks.sort((a, b) => a.t - b.t);
		const t0 = marks.length ? marks[0].t : 0;
		const start = marks.find((m) => m.name === 'region.hydrate.start');
		const done = marks.find((m) => m.name === 'region.hydrate.done');
		const hydrateMs = start && done ? done.t - start.t : (rendered && rendered.ms) ?? null;
		// what the browser measured of this island (the Page tab's row + the findings that name it)
		let browser = null;
		try {
			const view = info.fp ? read_page() : null;
			if (view) {
				const row = view.report.rows.find((r) => r.fp === info.fp) ?? null;
				const findings = view.report.findings.filter((f) => f.fps.includes(info.fp));
				if (row || findings.length) browser = { row, findings };
			}
		} catch {
			browser = null;
		}
		// what happened to it in the last recorded session (the Record tab): clicks, slow handlers, the
		// requests its clicks caused and the server's split of each
		last_session_version();
		const sess = get_last_session();
		const in_session = info.fp && sess ? (sess.report?.by_island?.[info.fp] ?? null) : null;
		// what the last SSR profile of this page measured for it (the Profiler tab's run)
		profiles_version();
		const prof = profile_for(location.pathname);
		const server = island_row(prof, info.fp, info.entry);
		return {
			info,
			name: region_name(info.entry),
			t,
			chunk,
			rendered,
			marks: marks.map((m) => ({ ...m, off: m.t - t0 })),
			hydrateMs,
			browser,
			server: server ? { row: server, at: prof.at, same: server.fp === info.fp } : null,
			session: in_session,
			props: decode_props(region_props_sidecar(el))
		};
	});

	// scroll to it AND mark it for a moment: an island already on screen gave no sign at all
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let flash;
	function locate() {
		highlight([el], model.name, true);
		clearTimeout(flash);
		flash = setTimeout(clear_highlight, 1400);
	}
	onDestroy(() => clearTimeout(flash));
</script>

<div class="detail" data-og-detail>
	<div class="bar">
		<button class="back" onclick={onclose} title="back to the roster">‹ back</button>
		<span class="dot og-{model.info.kind}"></span>
		<b class="name">{model.name}</b>
		<span class="k">{model.info.kind}{model.info.kind === 'island' ? ' · ' + model.info.wake : ''}</span>
		<button class="loc" onclick={locate}>scroll to it ›</button>
	</div>

	<div class="sec">lifecycle</div>
	{#if model.marks.length}
		<div class="life">
			{#each model.marks as m, i}
				{#if i > 0}<span class="arm"></span>{/if}
				<div class="ph" title="{m.name} @ +{m.off.toFixed(1)}ms">
					<span class="pd" style:background={m.c}></span><span class="pl">{m.label}</span>
					<span class="off">+{m.off.toFixed(1)}ms</span>
				</div>
			{/each}
		</div>
		{#if model.hydrateMs != null}
			<div class="hyd">hydrated in <b>{model.hydrateMs.toFixed(1)} ms</b></div>
		{/if}
	{:else}
		<div class="muted">
			{model.info.kind === 'island'
				? model.info.hydrated
					? 'hydrated (no timing captured this session)'
					: 'cold — has not woken yet'
				: 'no client lifecycle — pure server HTML'}
		</div>
	{/if}

	{#if model.browser}
		<div class="sec">in the browser <span class="secn">— measured on this visit</span></div>
		<div class="rows" data-og-detail-browser>
			{#if model.browser.row}
				{@const r = model.browser.row}
				<div class="row"><span class="rk">module load</span><span class="v">{r.load_ms} ms</span></div>
				{#if r.queue_ms !== null}<div class="row"><span class="rk">waited for its turn</span><span class="v">{r.queue_ms} ms</span></div>{/if}
				<div class="row"><span class="rk">hydrate step</span><span class="v">{r.hydrate_ms} ms{#if r.longtask_ms}<span class="muted"> · {r.longtask_ms} ms in long tasks</span>{/if}</span></div>
				<div class="row"><span class="rk">awake at</span><span class="v">{Math.round(r.done)} ms<span class="muted"> after navigation</span></span></div>
				{#if r.shift}<div class="row"><span class="rk">layout shift</span><span class="v">{r.shift}</span></div>{/if}
			{/if}
			{#each model.browser.findings as f, i (f.code + i)}
				<div class="find {f.severity}">{f.message}</div>
			{/each}
		</div>
	{/if}

	{#if model.session}
		{@const ss = model.session}
		<div class="sec">in the last session <span class="secn">— what using it did (Record tab)</span></div>
		<div class="rows" data-og-detail-session>
			<div class="row"><span class="rk">clicks</span><span class="v">{ss.clicks}{#if ss.mutations}<span class="muted"> · {ss.mutations} DOM changes</span>{/if}</span></div>
			{#each ss.slow as x, i (i)}
				<div class="row"><span class="rk">slow interaction</span><span class="v">{Math.round(x.duration)} ms<span class="muted"> · handlers {Math.round(x.processing)} ms · {x.target}</span></span></div>
			{/each}
			{#each ss.requests.slice(0, 5) as q, i (q.url + i)}
				<div class="row">
					<span class="rk">asked the server</span>
					<span class="v">{q.url} <b>{Math.round(q.ms)} ms</b>{#if q.status && q.status >= 400}<span class="muted"> · {q.status}</span>{/if}{#if q.server_ms !== null}<span class="muted"> · {Math.round(q.server_ms)} ms on the server{q.net_ms ? `, ${Math.round(q.net_ms)} ms waiting` : ''}{q.up ? ` (${q.up})` : ''}</span>{/if}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if model.server}
		{@const s = model.server.row}
		<div class="sec">on the server <span class="secn">— last profile, {new Date(model.server.at).toLocaleTimeString()}{model.server.same ? '' : ' (same island, other props)'}</span></div>
		<div class="rows" data-og-detail-server>
			<div class="row"><span class="rk">render</span><span class="v">{s.ssr_ms !== null ? s.ssr_ms + ' ms' : 'not measured'}</span></div>
			{#if s.props_bytes !== null}<div class="row"><span class="rk">props</span><span class="v">{kb(s.props_bytes)}{#if s.culprit}<span class="muted"> · not plain JSON: {s.culprit}</span>{/if}</span></div>{/if}
			{#if s.seed_refs}<div class="row"><span class="rk">seed references</span><span class="v">{s.seed_refs}</span></div>{/if}
			{#if s.client_p50_ms !== null}<div class="row"><span class="rk">hydrate (beacon)</span><span class="v">{s.client_p50_ms} ms{#if s.recovered}<span class="muted"> · recovered {s.recovered}×</span>{/if}</span></div>{/if}
			{#if s.hazard && !model.t?.hazards?.length}
				<!-- a build has no dev-server walk: the profiler's reading of its sources says it -->
				<div class="row" data-og-detail-hazard><span class="rk">browser-only</span><span class="v">{s.hazard.file.split('/').pop()}:{s.hazard.line} <span class="muted">· {s.hazard.kind === 'await' ? 'awaits at the top of its script' : `reads ${s.hazard.reads ?? 'a browser-only value'} ${s.hazard.guard ? 'in a guard' : 'while rendering'}`}</span></span></div>
			{/if}
		</div>
	{/if}

	<div class="sec">cost</div>
	<div class="rows">
		{#if ledger}
			<!-- a build: its files, weighed by the browser — what only it needs, and whom it shares with -->
			<div class="row" data-og-detail-bytes><span class="rk">its code</span><span class="v">{kb(ledger.row.wire)} in {ledger.row.files} files{#if ledger.row.cold}<span class="muted"> · {ledger.row.cold} not loaded yet</span>{/if}</span></div>
			<div class="row"><span class="rk">only it</span><span class="v">{kb(ledger.row.unique)}<span class="muted"> · what removing it would save</span></span></div>
			{#if ledger.row.shared}
				<div class="row"><span class="rk">shared</span><span class="v">{kb(ledger.row.shared)}{#if ledger.shares_with.length}<span class="muted"> · with {ledger.shares_with.slice(0, 4).join(', ')}{ledger.shares_with.length > 4 ? ` and ${ledger.shares_with.length - 4} more` : ''}</span>{/if}</span></div>
			{/if}
			{#if twice_here.length}
				<!-- a module in its files that the page loads a second copy of, elsewhere (the last profile) -->
				<div class="row" data-og-detail-twice><span class="rk">loaded twice</span><span class="v">{#each twice_here.slice(0, 3) as d, i (d.name)}{i ? ' · ' : ''}{d.name} <span class="muted">{kb(d.extra)}{d.mine.from ? `, its copy from ${d.mine.from}` : ''}</span>{/each}{#if twice_here.length > 3}<span class="muted"> and {twice_here.length - 3} more</span>{/if}</span></div>
			{/if}
		{/if}
		{#if model.t}
			<div class="row"><span class="rk">js + deps</span><span class="v">{kb(model.t.bytes)}<span class="muted"> · {model.t.modules} mod</span></span></div>
			{#if model.t.top?.length}
				<!-- where the island's weight is: its heaviest modules, as shares (dev code, unminified) -->
				<div class="row" data-og-detail-top><span class="rk">heaviest</span><span class="v">{#each model.t.top.slice(0, 3) as m, i (m.file)}{i ? ' · ' : ''}{m.file.split('/').pop()} <span class="muted">{Math.round((m.bytes / model.t.bytes) * 100)}%</span>{/each}</span></div>
			{/if}
			{#if model.t.barrels?.length}
				<div class="row" data-og-detail-barrel><span class="rk">barrel</span><span class="v">{model.t.barrels[0].file} <span class="muted">· {model.t.barrels[0].fanout} modules ride along</span></span></div>
			{/if}
			{#if model.t.hazards?.length}
				<!-- its lines that draw differently in the browser (the dev server read its sources): a
				     value only the browser has, read while rendering; an await at the top of its script -->
				{@const h = model.t.hazards[0]}
				<div class="row" data-og-detail-hazard><span class="rk">browser-only</span><span class="v">{h.file.split('/').pop()}:{h.line} <span class="muted">· {h.kind === 'await' ? 'awaits at the top of its script' : `reads ${h.reads ?? 'a browser-only value'} while rendering`}{model.t.hazards.length > 1 ? ` · ${model.t.hazards.length - 1} more` : ''}</span></span></div>
			{/if}
		{/if}
		{#if model.chunk?.loaded}
			<div class="row"><span class="rk">entry chunk</span><span class="v">{kb(model.chunk.wire)}<span class="muted"> wire · {kb(model.chunk.raw)} raw</span></span></div>
		{/if}
		{#if model.rendered?.propsBytes != null}
			<div class="row"><span class="rk">props payload</span><span class="v">{model.rendered.propsBytes} B</span></div>
		{/if}
		{#if model.rendered?.htmlBytes != null}
			<div class="row"><span class="rk">server HTML</span><span class="v">{model.rendered.htmlBytes} B</span></div>
		{/if}
	</div>

	{#if model.props}
		<div class="sec">props <span class="secn">— the data that crossed the boundary</span></div>
		<div class="props" data-og-props>
			{#each Object.entries(model.props) as [k, v] (k)}
				<PropsTree value={v} name={k} />
			{/each}
		</div>
	{/if}

	<div class="sec">identity</div>
	<div class="rows">
		<div class="row"><span class="rk">mode</span><span class="v">{model.rendered?.mode ?? model.info.kind}</span></div>
		<div class="row"><span class="rk">state</span><span class="v">{model.info.kind === 'island' ? (model.info.hydrated ? 'hydrated' : 'cold') : model.info.hydrated ? 'filled' : 'pending'}</span></div>
		<div class="row"><span class="rk">server-rendered</span><span class="v">{model.rendered ? 'yes' : 'no'}</span></div>
		{#if model.info.fp}<div class="row"><span class="rk">fingerprint</span><span class="v mono">{model.info.fp}</span></div>{/if}
		{#if model.info.entry}<div class="row"><span class="rk">entry</span><span class="v mono" title={model.info.entry}>{model.info.entry.split('/').pop()}</span></div>{/if}
	</div>
</div>

<style>
	.detail {
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-bottom: 10px;
		margin-bottom: 4px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
	}
	.back {
		padding: 3px 9px;
		border-radius: 6px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		background: #0d1526;
		color: #94a3b8;
		cursor: pointer;
		font: inherit;
	}
	.back:hover {
		color: #e2e8f0;
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex: none;
	}
	.dot.og-island {
		background: #14b8a6;
	}
	.dot.og-lake {
		background: #f59e0b;
	}
	.dot.og-hole {
		background: #8b5cf6;
	}
	.name {
		color: #e2e8f0;
		font-size: 13px;
		font-weight: 700;
	}
	.k {
		color: #94a3b8;
	}
	.loc {
		margin-left: auto;
		padding: 3px 9px;
		border-radius: 6px;
		border: 1px solid rgba(94, 234, 212, 0.3);
		background: rgba(20, 184, 166, 0.12);
		color: #5eead4;
		cursor: pointer;
		font: inherit;
	}
	.sec {
		margin: 12px 0 6px;
		color: #94a3b8;
		font-weight: 600;
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.04em;
	}
	.secn {
		text-transform: none;
		letter-spacing: 0;
		color: #94a3b8;
		font-weight: 400;
	}
	.props {
		padding: 8px 10px;
		border-radius: 8px;
		background: rgba(148, 163, 184, 0.06);
		border: 1px solid rgba(148, 163, 184, 0.14);
		max-height: 240px;
		overflow: auto;
	}
	.life {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ph {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.1);
	}
	.pd {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}
	.pl {
		color: #e2e8f0;
	}
	.off {
		color: #94a3b8;
		font-size: 10px;
	}
	.arm {
		width: 10px;
		height: 1px;
		background: rgba(148, 163, 184, 0.4);
	}
	.hyd {
		margin-top: 8px;
		color: #94a3b8;
	}
	.hyd b {
		color: #5eead4;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		padding: 2px 0;
	}
	.rk {
		color: #94a3b8;
	}
	.v {
		color: #e2e8f0;
	}
	.muted {
		color: #94a3b8;
	}
	.mono {
		color: #cbd5e1;
	}
	.find {
		margin-top: 4px;
		padding: 4px 8px;
		border-left: 3px solid #38bdf8;
		background: rgba(148, 163, 184, 0.07);
		border-radius: 4px;
		line-height: 1.5;
	}
	.find.warn {
		border-left-color: #f59e0b;
	}
	.find.error {
		border-left-color: #ef4444;
	}
</style>
