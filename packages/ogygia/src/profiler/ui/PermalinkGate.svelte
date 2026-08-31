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
	import type { Analysis } from '../analyze.js';
	import type { ReportMeta, ReportExtras } from '../report.js';

	let { base }: { base: string } = $props();

	const blob = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
	let password = $state('');
	let busy = $state(false);
	let error = $state('');
	let report = $state<{ a: Analysis; meta: ReportMeta; extras: ReportExtras } | null>(null);

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
	<ReportBody a={report.a} meta={report.meta} {base} extras={report.extras} ogpB64={undefined} />
{:else}
	<Shell>
		<div class="share-unlock">
			{#if !blob}
				<h1>No shared report here</h1>
				<p class="hint">
					This link carries no report. Open a share link (it ends in <code>#…</code>), or log in to
					view your own reports.
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
