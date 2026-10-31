/**
 * Is this module id a request for the module's SCRIPT? The query decides. vite-plugin-svelte serves
 * a component's extracted CSS as `Foo.svelte?svelte&type=style&lang.css`, and Vite's `?raw`, `?url`,
 * `?inline`, `?worker` are not the module's code either. Passes that strip the query before an
 * extension test took those for the component: the barrel rewrite ran the Svelte parser over plain
 * CSS, threw, and reported every component with a `<style>` as skipped (3,233 false warnings in one
 * production build, burying the real ones). A cache query (`?v=123`, `?t=…`) or ogygia's own
 * (`?og-region`) is still the script. String scanning, no regex: it runs for every module.
 */

/** Vite's query flags whose payload is not the module's script */
const NON_SCRIPT_FLAGS = new Set(['raw', 'url', 'inline', 'worker', 'sharedworker', 'direct']);
const SCRIPT_LANGS = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);

export function is_script_request(id: string): boolean {
	const q = id.indexOf('?');
	if (q === -1) return true;
	const end = id.indexOf('#', q);
	for (const part of id.slice(q + 1, end === -1 ? undefined : end).split('&')) {
		const eq = part.indexOf('=');
		const key = eq === -1 ? part : part.slice(0, eq);
		if (NON_SCRIPT_FLAGS.has(key)) return false;
		if (key === 'type' && part.slice(eq + 1) !== 'script') return false;
		if (key.startsWith('lang.') && !SCRIPT_LANGS.has(key.slice(5))) return false;
	}
	return true;
}
