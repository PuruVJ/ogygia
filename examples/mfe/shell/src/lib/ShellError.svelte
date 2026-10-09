<script lang="ts">
	// The shell's error boundary for mounted apps — the "team is down" card.
	let { status, error }: { status: number; error: { message: string } } = $props();
</script>

<main>
	<div class="card" data-testid="mount-failed">
		<h2>⚠ {status}</h2>
		<p>{error?.message}</p>
		<p class="sub">The rest of ACME Suite is unaffected. <a href="/">Back to home</a></p>
	</div>
</main>

<style>
	main { max-width: 720px; margin: 2rem auto; font-family: system-ui, sans-serif; }
	.card {
		border: 2px dashed #dc2626;
		border-radius: 10px;
		padding: 1.5rem;
		color: #991b1b;
		background: #fef2f2;
	}
	.card h2 { margin: 0 0 0.5rem; }
	.sub { color: #6b7280; }
</style>
