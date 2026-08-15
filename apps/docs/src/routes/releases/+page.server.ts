/**
 * Releases — prerendered. The notes are rendered from the repo-root `CHANGELOG.md` at build time
 * (Shiki + markdown-it in `releases.server.ts`), so this page ships as static HTML with zero
 * client JS beyond the site chrome.
 */
import { get_releases } from '$lib/releases.server';

export const prerender = true;

export async function load() {
	return { releases: await get_releases() };
}
