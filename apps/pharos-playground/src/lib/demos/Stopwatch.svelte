<script lang="ts">
	// A live island with its own ticking state — start/stop/reset. Demonstrates that an island keeps
	// real client state (a running interval) while the rest of the page is static SSR HTML.
	let ms = $state(0);
	let running = $state(false);
	let handle: ReturnType<typeof setInterval> | undefined;

	function toggle() {
		running = !running;
		if (running) {
			const start = Date.now() - ms;
			handle = setInterval(() => (ms = Date.now() - start), 16);
		} else clearInterval(handle);
	}
	function reset() {
		clearInterval(handle);
		running = false;
		ms = 0;
	}
	const shown = $derived(
		`${Math.floor(ms / 1000)
			.toString()
			.padStart(2, '0')}.${Math.floor((ms % 1000) / 10)
			.toString()
			.padStart(2, '0')}`
	);
</script>

<div class="demo-sw">
	<time class:running>{shown}</time>
	<button type="button" onclick={toggle}>{running ? 'Stop' : 'Start'}</button>
	<button type="button" class="ghost" onclick={reset}>Reset</button>
</div>

<style>
	.demo-sw {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--ph-line, #e4e4e8);
		border-radius: 12px;
		background: var(--ph-bg-subtle, #f7f7f8);
	}
	time {
		min-width: 4.5rem;
		font-family: var(--ph-mono, monospace);
		font-size: 1.4rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ph-text, #1c1c21);
	}
	time.running {
		color: var(--ph-accent, #0d9488);
	}
	button {
		padding: 0.4rem 0.85rem;
		border: 1px solid transparent;
		border-radius: 9px;
		background: var(--ph-accent, #0d9488);
		color: #fff;
		font-weight: 600;
		cursor: pointer;
	}
	button.ghost {
		background: var(--ph-thumb, #fff);
		color: var(--ph-text-dim, #55555c);
		border-color: var(--ph-line, #e4e4e8);
	}
	button:active {
		transform: scale(0.96);
	}
</style>
