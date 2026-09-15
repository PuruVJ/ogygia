<script lang="ts">
	// SEED SHAPING fixture, the CONTROL: this island hands the whole `page.data` to a helper, so the
	// build cannot pin its reads and the seed must ship everything (`big` included) — doubt goes to all.
	import { page } from '$app/state';
	const pick = (d: Record<string, unknown>, k: string) => String(d[k] ?? '');
	const small = $derived(pick(page.data as Record<string, unknown>, 'small'));
	const bigLen = $derived(pick(page.data as Record<string, unknown>, 'big').length);
</script>

<div data-seed-shape-all><span data-small>{small}</span> big:<span data-big-len>{bigLen}</span></div>
