import { highlight } from '$lib/code/highlight.server.js';
import * as snip from '$lib/code/snippets.js';

export async function load() {
	const [loadCode, idleCode, visibleCode, mediaCode, presetCode] = await Promise.all([
		highlight(snip.hydrateLoad, 'svelte'),
		highlight(snip.hydrateIdle, 'svelte'),
		highlight(snip.hydrateVisible, 'svelte'),
		highlight(snip.hydrateMedia, 'svelte'),
		highlight(snip.presetDemo, 'svelte')
	]);

	return { loadCode, idleCode, visibleCode, mediaCode, presetCode };
}
