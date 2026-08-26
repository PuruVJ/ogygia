<script lang="ts">
	/**
	 * "Share link" on your own report (`wake:'load'`). Fetches the report's plaintext dump (only when you
	 * click — the authed `.dump` endpoint), encrypts it with a password YOU set (see permalink.ts), and
	 * hands back a `…/report/<id>#<blob>` URL. The report lives in the `#fragment` — zero server storage,
	 * decrypted in the recipient's browser (PermalinkGate). Browser-gated: WebKit (Safari + iOS) caps
	 * URLs too low, so links are disabled there; Chromium/Firefox go up to ~1.5 MB, with a Safari-
	 * recipient disclaimer past the universal-safe size. No `$effect`; all state moves on click/submit.
	 */
	import { encode_permalink, is_webkit_capped, MAX_PERMALINK_CHARS } from './permalink.js';

	let { id, base }: { id: string; base: string } = $props();

	// WebKit check needs `navigator` — false during SSR, corrected on hydrate.
	const capped = typeof navigator !== 'undefined' && is_webkit_capped();
	// Under Safari's ~80 K hard cap (with margin) a link opens EVERYWHERE; above it, Chromium/Firefox only.
	const SAFE_UNIVERSAL = 56_000;

	let open = $state(false);
	let password = $state('');
	let busy = $state(false);
	let url = $state('');
	let note = $state('');
	let err = $state('');
	let copied = $state(false);

	async function generate(e: Event) {
		e.preventDefault();
		if (busy || !password) return;
		busy = true;
		err = '';
		url = '';
		note = '';
		try {
			const res = await fetch(`${base}/report/${id}.dump`, { credentials: 'same-origin' });
			if (!res.ok) throw new Error('fetch');
			const blob = await encode_permalink(await res.json(), password);
			if (blob.length > MAX_PERMALINK_CHARS) {
				err = `This report is ~${Math.round(blob.length / 1024)} KB encoded — too big for a link. Download the .ogp and share the file instead.`;
				return;
			}
			url = `${location.origin}${base}/report/${id}#${blob}`;
			if (blob.length > SAFE_UNIVERSAL)
				note = 'Large link — opens in Chrome & Firefox; Safari recipients need the .ogp file.';
		} catch {
			err = 'Could not build the link.';
		} finally {
			busy = false;
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the field is selectable */
		}
	}
</script>

{#if capped}
	<button
		type="button"
		class="btn"
		disabled
		title="Universal link sharing is off in Safari — share the .ogp file, or open in Chrome / Firefox"
	>
		Share link<span class="sub">Safari: use .ogp</span>
	</button>
{:else}
	<button type="button" class="btn" onclick={() => (open = !open)}>
		Share link<span class="sub">URL + password</span>
	</button>
{/if}

{#if open && !capped}
	<div class="share-panel">
		<p class="hint">
			Anyone with this link <b>and</b> the password can read the report. It's encrypted into the link —
			nothing is stored on any server.
		</p>
		<form class="share-form" onsubmit={generate}>
			<input
				type="password"
				bind:value={password}
				placeholder="set a password"
				autocomplete="new-password"
				disabled={busy}
			/>
			<button type="submit" disabled={busy || !password}>{busy ? 'Encrypting…' : 'Generate'}</button>
		</form>
		{#if err}<p class="share-err">{err}</p>{/if}
		{#if url}
			<div class="share-out">
				<input type="text" readonly value={url} onclick={(e) => e.currentTarget.select()} />
				<button type="button" onclick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
			</div>
			{#if note}<p class="share-note">{note}</p>{/if}
		{/if}
	</div>
{/if}

<style>
	.share-panel {
		margin: 4px 0 14px;
		padding: 12px 14px;
		border: 1px solid #232a35;
		border-radius: 10px;
		background: #0e131a;
		max-width: 640px;
	}
	.share-out {
		display: flex;
		gap: 8px;
		margin: 10px 0 0;
	}
	.share-out input {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid #2b3340;
		background: #0a0d11;
		color: #9fb0c4;
		font: 12px ui-monospace, monospace;
	}
	.share-out button {
		padding: 8px 12px;
		border-radius: 8px;
		border: 1px solid #2b3340;
		background: #1c2530;
		color: #d8dee6;
		cursor: pointer;
		font: inherit;
		font-size: 12.5px;
		white-space: nowrap;
	}
	.share-note {
		color: #d9a03d;
		font-size: 12px;
		margin: 8px 0 0;
	}
</style>
