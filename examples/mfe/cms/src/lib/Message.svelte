<script lang="ts">
	// Error boundary — Kit-shaped props: { status, error: { message } }.
	let { status, error }: { status: number; error: { message: string } } = $props();
</script>

<div data-testid="cms-error"><strong>{status}</strong> — {error?.message}</div>
