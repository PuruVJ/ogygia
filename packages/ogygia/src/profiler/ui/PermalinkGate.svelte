<script lang="ts">
	/**
	 * The share-link viewer, a `wake:'load'` island. The report rides in the URL `#fragment` (which the
	 * browser never sends anywhere); this reads it, asks for the password the sender set, decrypts it
	 * IN THE BROWSER (Web Crypto — see permalink.ts), and renders the same {@link ./ReportBody.svelte}.
	 * Zero-knowledge: the server serves an empty page; the report never touches it. No `$effect` — the
	 * fragment is read once at setup, and unlock is a submit handler (reactivity-dom-preferences).
	 */
	import Shell from './Shell.svelte';
	import ReportBody from './ReportBody.svelte';
	import { decode_permalink } from './permalink.js';
	import { get_report, list_reports } from './store.js';
	import { page_history } from '../compare.js';
	import type { Analysis } from '../analyze.js';
	import type { ReportMeta, ReportExtras } from '../report.js';
	import type { PageHistory } from '../profiler-router.js';

	// ── regexes
	const LEADING_HASH_RE = /^#/;

	let {
		base,
		login = null,
		exists = false
	}: {
		base: string;
		/** the login page (with `next` back here) when the UI is secret-gated and the visitor is not in */
		login?: string | null;
		/** this server holds the report — the visitor just is not logged in */
		exists?: boolean;
	} = $props();

	const blob = typeof location !== 'undefined' ? location.hash.replace(LEADING_HASH_RE, '') : '';
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	let report = $state<{ a: Analysis; meta: ReportMeta; extras: ReportExtras; history?: PageHistory | null; prev?: string | null } | null>(null);
	/** THE BROWSER STORE: no fragment → this may be a report this browser kept (an ephemeral host
	 *  no longer has it, or the server restarted). Looked up once, by the id in the URL. */
	let looking = $state(!blob && typeof location !== 'undefined');
	if (looking) {
		const id = location.pathname.split('/').filter(Boolean).pop() ?? '';
		void get_report(id)
			.then(async (rec) => {
				const dump = rec?.dump as { analysis: Analysis; meta: ReportMeta; extras: ReportExtras } | null | undefined;
				if (!dump?.analysis || !dump.meta) return;
				// this page's history from the other reports this browser kept
				const kept = await list_reports();
				const metas = [dump.meta, ...(await Promise.all(kept.filter((k) => k.id !== dump.meta.id && k.page === dump.meta.page).map((k) => get_report(k.id)))).map((r) => (r?.dump as { meta: ReportMeta } | undefined)?.meta).filter((m): m is ReportMeta => !!m)];
				const history = page_history(metas).find((h) => h.page === dump.meta.page) ?? null;
				const i = history ? history.points.findIndex((p) => p.id === dump.meta.id) : -1;
				report = { a: dump.analysis, meta: dump.meta, extras: dump.extras, history, prev: i > 0 ? history!.points[i - 1].id : null };
			})
			.finally(() => (looking = false));
	}

	async function unlock(e: Event) {
		e.preventDefault();
		if (!blob || busy) return;
		busy = true;
		error = '';
		try {
			const dump = (await decode_permalink(blob, password)) as {
				analysis: Analysis;
				meta: ReportMeta;
				extras: ReportExtras;
			};
			report = { a: dump.analysis, meta: dump.meta, extras: dump.extras };
		} catch {
			error = 'Wrong password, or the link is corrupted.';
		} finally {
			busy = false;
		}
	}
</script>

{#if report}
	<ReportBody a={report.a} meta={report.meta} {base} extras={report.extras} ogpB64={undefined} history={report.history ?? null} prev={report.prev ?? null} />
{:else}
	<Shell {base}>
		<div class="share-unlock">
			{#if looking}
				<h1>Looking in this browser…</h1>
				<p class="hint">The server does not hold this report; checking whether this browser kept it.</p>
			{:else if !blob && exists && login}
				<h1>Log in to view this report</h1>
				<p class="hint">
					This report is on this server; you are not logged in on this browser. Log in with the
					profiler secret and you land right back here.
				</p>
				<a class="btn" href={login}>Log in with the secret</a>
			{:else if !blob}
				<h1>No report here</h1>
				<p class="hint">
					This server does not hold it and this browser did not keep it (an ephemeral host keeps a
					report only in the browser that recorded it). Open a share link (it ends in <code>#…</code>){#if login},
						or <a href={login}>log in with the profiler secret</a> to view your own reports{:else},
						or log in to view your own reports{/if}.
				</p>
				<a class="btn" href={base}>← dashboard</a>
			{:else}
				<h1>Shared profile</h1>
				<p class="hint">This report is encrypted in the link. Enter the password the sender gave you.</p>
				<form class="share-form" onsubmit={unlock}>
					<input
						type="password"
						bind:value={password}
						placeholder="password"
						autocomplete="off"
						disabled={busy}
					/>
					<button type="submit" disabled={busy || !password}>
						{busy ? 'Decrypting…' : 'View report'}
					</button>
				</form>
				{#if error}<p class="share-err">{error}</p>{/if}
			{/if}
		</div>
	</Shell>
{/if}

<style>
	/* The recipient's unlock page. `.share-form` / `.share-err` base styles are shared (Shell global);
	   these are just this page's centered-layout overrides. */
	.share-unlock {
		max-width: 460px;
		margin: 12vh auto 0;
		text-align: center;
	}
	.share-unlock h1 {
		margin: 0 0 8px;
	}
	.share-unlock .share-form {
		max-width: 360px;
		margin: 16px auto 0;
	}
	.share-unlock .share-err {
		text-align: center;
	}
</style>
