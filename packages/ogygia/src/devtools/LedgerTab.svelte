<script>
	/**
	 * The Bytes tab (byte ledger): real over-the-wire JS per island entry chunk + the shared runtime
	 * chunk, from PerformanceResourceTiming. Cold islands show `cold` and fill in live as the panel
	 * ticks. Measures each island's OWN chunk (not transitive deps); dev sizes are flagged.
	 */
	import {
		all_regions,
		chunk_bytes,
		basename,
		kb,
		region_name,
		region_transitive
	} from './regions.js';

	import { page_ledger } from './ledger-dom.js';
	import { profile_for, profiles_version } from './profile-store.js';

	let { tick = 0 } = $props();
	const IS_DEV = !!(import.meta.env && import.meta.env.DEV);

	// THE EXACT LEDGER (a build): the page's island graph names every file each island needs, the
	// browser says what each file weighed — each file counted once, and per island what only it needs
	const exact = $derived.by(() => {
		tick;
		return page_ledger();
	});
	// the modules the build shipped twice that this page loads both copies of (the last profile's)
	const twice = $derived.by(() => {
		tick;
		profiles_version();
		return profile_for(location.pathname)?.assets?.twice ?? [];
	});

	const model = $derived.by(() => {
		tick; // refresh with the panel tick

		// Group regions by entry chunk (dedupe: same component + strategy = ONE chunk, N instances).
		const groups = new Map();
		for (const r of all_regions()) {
			if (!r.entry) continue;
			const key = basename(r.entry);
			const g = groups.get(key);
			if (g) g.count++;
			else groups.set(key, { entry: r.entry, kind: r.kind, wake: r.wake, count: 1 });
		}

		const rows = [...groups.values()]
			.map((g) => {
				const t = region_transitive(g.entry);
				return {
					...g,
					...chunk_bytes(g.entry),
					name: region_name(g.entry),
					transitive: t ? t.bytes : 0,
					modules: t ? t.modules : 0
				};
			})
			// Sort by the real (transitive) cost when we have it, else by the entry-chunk wire size.
			.sort((a, b) => b.transitive - a.transitive || b.wire - a.wire);

		const runtimeSrc =
			document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src') || '';
		const runtime = runtimeSrc ? { src: runtimeSrc, ...chunk_bytes(runtimeSrc) } : null;

		// Page total over UNIQUE chunks (rows are already one-per-island). `wire` = wrapper chunks;
		// `transitive` = each island's whole subgraph (the real-cost column).
		const counted = new Set();
		let wire = 0;
		let transitive = 0;
		for (const row of rows) {
			const key = basename(row.entry);
			if (counted.has(key)) continue;
			counted.add(key);
			if (row.loaded) wire += row.wire;
			transitive += row.transitive;
		}
		if (runtime?.loaded && !counted.has(basename(runtime.src))) wire += runtime.wire;
		return { rows, runtime, totalWire: wire, totalTransitive: transitive };
	});
</script>

<h3>byte ledger — JavaScript per island</h3>
{#if exact}
	<div class="note" data-og-ledger-exact>
		Every file each island needs, from the page's island graph, weighed by the browser (over the wire).
		<b>only it</b> is what that island alone needs: what removing it would save. <b>shared</b> it shares with
		other islands. The page total counts each file once.
	</div>
	<table>
		<thead>
			<tr><th>island</th><th>kind</th><th>files</th><th>loaded</th><th>only it</th><th>shared</th></tr>
		</thead>
		<tbody>
			{#each exact.rows as row (row.entry)}
				<tr>
					<td title={row.entry}><span class="nm">{row.name}</span>{#if row.count > 1}<span class="muted"> ×{row.count}</span>{/if}</td>
					<td>{row.kind}{row.kind === 'island' ? ' · ' + row.wake : ''}</td>
					<td>{row.files}{#if row.cold}<span class="muted"> · {row.cold} cold</span>{/if}</td>
					<td>{#if row.files > row.cold}{kb(row.wire)}{:else}<span class="muted">cold</span>{/if}</td>
					<td><span class="strong">{kb(row.unique)}</span></td>
					<td class="muted">{kb(row.shared)}</td>
				</tr>
			{/each}
			<tr>
				<td>ogygia runtime</td>
				<td class="muted">every island</td>
				<td>{exact.runtime.files}</td>
				<td>{kb(exact.runtime.wire)}</td>
				<td class="muted">—</td>
				<td class="muted">—</td>
			</tr>
		</tbody>
		<tfoot>
			<tr>
				<td>page</td>
				<td class="muted">each file once</td>
				<td>{exact.page.files}{#if exact.page.cold}<span class="muted"> · {exact.page.cold} cold</span>{/if}</td>
				<td>{kb(exact.page.wire)}</td>
				<td colspan="2" class="muted">{kb(exact.page.raw)} decoded</td>
			</tr>
		</tfoot>
	</table>
	{#if exact.shared.length}
		<h3 class="sub">shared files</h3>
		<table data-og-ledger-shared>
			<tbody>
				{#each exact.shared.slice(0, 8) as s (s.url)}
					<tr>
						<td title={s.url}>{basename(s.url)}</td>
						<td>{kb(s.wire)}</td>
						<td class="muted">{s.users.length > 4 ? `${s.users.slice(0, 3).join(', ')} and ${s.users.length - 3} more` : s.users.join(', ')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	{#if twice.length}
		<!-- the last profile of this page: modules the build shipped twice, both copies loaded here -->
		<h3 class="sub">loaded twice</h3>
		<div class="note" data-og-ledger-twice>
			One module reached by two paths (a package's source and its build, or two of its versions) ships as
			two copies, and this page loads both: {kb(twice.reduce((s, d) => s + d.extra, 0))} of code its browser
			downloads, parses and runs a second time. From the last profile.
		</div>
		<table>
			<tbody>
				{#each twice.slice(0, 8) as d (d.name)}
					<tr>
						<td>{d.name}</td>
						<td>{kb(d.extra)}</td>
						<td class="muted">{d.copies.map((c) => `${basename(c.file)}${c.from ? ` (${c.from})` : ''}`).join(' · ')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
{:else}
<div class="note">
	Each <b>+deps</b> figure is that island's <b>whole bundle</b> — the component plus every shared function
	and utility it imports. Shared code is therefore counted in <em>every</em> island that uses it, so the
	figures overlap and the page total over-counts code that actually ships once.{#if IS_DEV}
		Dev estimate: sizes are unbundled/unminified — build + preview for shipped numbers.{/if} A cold island
	(not yet woken) shows <b>—</b> until it loads.
</div>

<table>
	<thead>
		<tr><th>island</th><th>kind</th><th>wrapper</th><th>+deps</th></tr>
	</thead>
	<tbody>
		{#each model.rows as row (row.entry)}
			<tr>
				<td title={row.entry}>
					<span class="nm">{row.name}</span>{#if row.count > 1}<span class="muted"> ×{row.count}</span>{/if}
				</td>
				<td>{row.kind}{row.kind === 'island' ? ' · ' + row.wake : ''}</td>
				<td>{#if row.loaded}{kb(row.wire)}{:else}<span class="muted">cold</span>{/if}</td>
				<td>
					{#if row.transitive}
						<span class="strong">{kb(row.transitive)}</span><span class="muted"> · {row.modules} mod</span>
					{:else}<span class="muted">—</span>{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="muted">no island chunks on this page</td></tr>
		{/each}
		{#if model.runtime}
			<tr>
				<td>ogygia runtime</td>
				<td class="muted">shared</td>
				<td>{model.runtime.loaded ? kb(model.runtime.wire) : '—'}</td>
				<td class="muted">—</td>
			</tr>
		{/if}
	</tbody>
	<tfoot>
		<tr>
			<td>page total</td><td class="muted">unique · +deps</td>
			<td>{kb(model.totalWire)}</td><td>{kb(model.totalTransitive)}</td>
		</tr>
	</tfoot>
</table>
{/if}

<style>
	h3 {
		margin: 0 0 8px;
		font-size: 12px;
		color: #5eead4;
	}
	h3.sub {
		margin-top: 12px;
	}
	.note {
		color: #94a3b8;
		margin-bottom: 6px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: right;
		padding: 2px 8px;
		white-space: nowrap;
	}
	th:first-child,
	td:first-child,
	th:nth-child(2),
	td:nth-child(2) {
		text-align: left;
	}
	thead th {
		color: #94a3b8;
		border-bottom: 1px solid rgba(148, 163, 184, 0.2);
	}
	tfoot td {
		border-top: 1px solid rgba(148, 163, 184, 0.2);
		color: #5eead4;
		font-weight: 600;
	}
	.muted {
		color: #94a3b8;
	}
	.nm {
		color: #e2e8f0;
		font-weight: 600;
	}
	.strong {
		color: #e2e8f0;
	}
</style>
