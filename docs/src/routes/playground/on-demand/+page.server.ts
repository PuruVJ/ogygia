import { onDemandPageSnippets } from '$lib/code/snippets.remote.js';

export async function load() {
	return await onDemandPageSnippets();
}
