<script lang="ts">
	/**
	 * The run page body — a `wake:'load'` island. On wake it fires the profile at `<base>/page`, shows a
	 * Windows-style progress bar while the server renders + samples, then swaps to the report (navigates
	 * this document to `/report/<id>`, so an embedding devtools iframe shows the whole thing). For the
	 * `.ogp` path it downloads the encrypted file instead. It also postMessages the final report URL to a
	 * parent frame, so the devtools tab can offer "open in new tab".
	 */
	import { onMount } from 'svelte';
	import { fake_progress } from './fake-progress.svelte.js';

	// ── regexes
	const NON_WORD_G = /\W+/g;

	let {
		base,
		path,
		runs,
		format
	}: { base: string; path: string; runs: number; format: string } = $props();

	// A busy worker answers /page with 409 (one recording per worker — the V8 profiler is process-wide).
	// There's no server-side queue to rely on (a serverless worker is recycled within ~30s), so the QUEUE
	// LIVES HERE: poll until a worker accepts. On serverless the retry lands on a free worker; on a single
	// server it comes back once the run ahead finishes. Give up after QUEUE_MAX_MS and point at Reset.
	const QUEUE_POLL_MS = 2000;
	const QUEUE_MAX_MS = 120_000;

	const p = fake_progress();
	let phase = $state('Starting the profiler…');
	let error = $state('');
	let done_ogp = $state(false);
	let queued = $state(false);
	let waited_s = $state(0);

	/** Fetch /page, polling while any worker we reach is busy. Returns the first non-409 response, or the
	 *  last 409 if we waited past QUEUE_MAX_MS (the caller surfaces that as an error). */
	async function fetch_page(url: string): Promise<Response> {
		const started = Date.now();
		for (;;) {
			queued = false;
			p.start();
			phase = `Rendering ${path} ${runs}× and sampling the server…`;
			const res = await fetch(url);
			if (res.status !== 409) return res;
			// busy — enter/stay in the queue
			if (Date.now() - started > QUEUE_MAX_MS) return res;
			queued = true;
			const retry_after = Number(res.headers.get('retry-after')) * 1000;
			const delay = Number.isFinite(retry_after) && retry_after > 0 ? retry_after : QUEUE_POLL_MS;
			waited_s = Math.round((Date.now() - started) / 1000);
			phase = 'In queue — a profile is already running. Waiting for a free worker…';
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	async function run() {
		try {
			const suffix = format === 'ogp' ? '&format=ogp' : '';
			const res = await fetch_page(`${base}/page?p=${encodeURIComponent(path)}&runs=${runs}${suffix}`);
			if (!res.ok) throw new Error(String(res.status));
			if (format === 'ogp') {
				const blob = await res.blob();
				await p.finish();
				const a = document.createElement('a');
				const href = URL.createObjectURL(blob);
				a.href = href;
				a.download = `profile-${path.replace(NON_WORD_G, '_') || 'page'}.ogp`;
				a.click();
				URL.revokeObjectURL(href);
				done_ogp = true;
				phase = 'Downloaded the encrypted .ogp.';
			} else {
				// /page renders N times then 303s to /report/<id>; fetch follows it → res.url is the report
				const url = res.url;
				await p.finish();
				phase = 'Opening the report…';
				try {
					window.parent?.postMessage({ type: 'ogygia:profiled', url }, location.origin);
				} catch {
					/* no parent / cross-origin — fine */
				}
				location.href = url;
			}
		} catch (e) {
			p.fail();
			queued = false;
			const code = e instanceof Error ? e.message : 'error';
			error =
				`Profiling failed (${code}). If the page is slow, the host's request timeout may have cut it ` +
				`off — try fewer renders, or tick the .ogp download and open it via Import. If a run got ` +
				`stuck, hit Reset on the dashboard.`;
		}
	}

	onMount(run);
</script>

<div class="run">
	<p class="phase">{queued ? '⏳ ' : ''}{phase}</p>
	{#if queued}
		<p class="hint">
			Waited {waited_s}s. Recordings run one at a time per worker (the V8 profiler is process-wide) —
			this keeps polling until one is free, then measures automatically.
		</p>
	{:else}
		<div class="track"><div class="fill" style="width:{p.value}%"></div></div>
		<p class="pct">{Math.round(p.value)}%</p>
	{/if}

	{#if error}
		<p class="verdict">{error}</p>
		<p class="hint"><a href={base}>← back to the dashboard</a></p>
	{:else if done_ogp}
		<p class="hint">
			Your download didn't start? <a href="{base}/view">Open the Import page</a> and pick the file.
		</p>
		<p class="hint"><a href={base}>← back to the dashboard</a></p>
	{/if}
</div>

<style>
	.run {
		max-width: 44rem;
		margin: 2rem 0;
	}
	.phase {
		margin: 0 0 0.6rem;
		font-weight: 600;
	}
	.track {
		height: 12px;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.22);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(90deg, #14b8a6, #0ea5e9);
		transition: width 0.24s ease-out;
	}
	.pct {
		margin: 0.4rem 0 0;
		font-variant-numeric: tabular-nums;
		opacity: 0.7;
	}
</style>
