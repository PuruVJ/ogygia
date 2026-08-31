<script lang="ts">
	/**
	 * The unlock form — a `wake: 'load'` island (real reactive state, was report.ts's inline login
	 * script). Posts the key as JSON (NOT a form POST) so Kit's CSRF — which only guards form
	 * content-types and would otherwise need the app's ORIGIN set — never applies; the session cookie
	 * rides the response. On success it navigates to `next`.
	 */
	let { base, next }: { base: string; next: string } = $props();
	let key = $state('');
	let wrong = $state(false);

	async function submit(ev: SubmitEvent) {
		ev.preventDefault();
		wrong = false;
		try {
			const r = await fetch(base + '/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key, next })
			});
			if (r.ok) {
				const d = await r.json();
				location.href = d.next || base;
				return;
			}
		} catch {
			/* network error → treated as a failed unlock below */
		}
		wrong = true;
		key = '';
	}
</script>

<p class="hint">Enter the profiler key to continue. It's kept for this browser session.</p>
{#if wrong}<p class="verdict">Wrong key.</p>{/if}
<form class="inline" onsubmit={submit}>
	<label>
		key
		<!-- svelte-ignore a11y_autofocus -->
		<input
			type="password"
			bind:value={key}
			autofocus
			size="34"
			autocomplete="current-password"
		/>
	</label>
	<button class="btn primary">Unlock</button>
</form>
