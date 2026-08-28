<script lang="ts">
	// The LAZY client-stitch hole: an island that fetches its fragment through the SHELL's
	// proxy after the page is up. Placeholder until the doc arrives; failed card on error;
	// the swapped-in HTML's own <ogygia-region>s connect and wake on their own schedules.
	let { app, name, props = {} }: { app: string; name: string; props?: Record<string, string> } = $props();
	let state = $state<'loading' | 'done' | 'failed'>('loading');
	let html = $state('');
	let css = $state('');

	$effect(() => {
		const q = new URLSearchParams(props);
		fetch(`/og/frag/${app}:${name}?${q}`)
			.then((r) => r.json())
			.then((doc) => {
				if (doc.failed) { state = 'failed'; return; }
				css = (doc.css ?? []).join('');
				html = doc.html ?? doc.body ?? '';
				state = 'done';
			})
			.catch(() => (state = 'failed'));
	});
</script>

{#if state === 'loading'}
	<div class="skeleton" data-testid="hole-loading">loading {name}…</div>
{:else if state === 'failed'}
	<div class="failed" data-testid="hole-failed">fragment <b>{name}</b> unavailable — the rest of the page is fine.</div>
{:else}
	<!-- eslint-disable-next-line svelte/no-at-html-tags — trusted federation -->
	<div data-testid="hole-done">{@html css}{@html html}</div>
{/if}

<style>
	.skeleton {
		background: linear-gradient(90deg, #f3f4f6, #e5e7eb, #f3f4f6);
		border-radius: 8px;
		padding: 2rem;
		color: #9ca3af;
	}
	.failed {
		border: 2px dashed #dc2626;
		border-radius: 8px;
		padding: 1rem;
		color: #dc2626;
	}
</style>
