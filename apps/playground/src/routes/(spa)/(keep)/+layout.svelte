<script lang="ts">
	// Continuity demo layout: the persistent player lives here (not the shared spa layout) so its
	// island region only appears on these pages. `track` is the route path — it DIFFERS per page, so
	// the relocated live player must have the new page's track pushed into it (prop-push).
	import { page } from '$app/state';
	import PersistPlayer from '$lib/PersistPlayer.svelte' with { wake: 'load', keep: 'player' };
	let { children } = $props();
</script>

<PersistPlayer track={page.url.pathname} />
{@render children()}
