import { docsPageSnippets } from '$lib/code/snippets.remote.js';

export async function load() {
	return await docsPageSnippets();
}
