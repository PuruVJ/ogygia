<script lang="ts">
	// An island in the header: its state must survive the header's refresh, and it reads the locale.
	import { page } from '$app/state';
	let count = $state(0);
</script>

<button data-hl-counter data-locale={(page.data as { locale?: string }).locale ?? ''} onclick={() => count++}>
	{(page.data as { locale?: string }).locale ?? '-'} · {count}
</button>
