/**
 * The devtools DOCK — one `mount()` of the {@link ./Devtools.svelte root app} into the shadow root
 * the launcher (ui.ts) made. Its own module so a build with devtools (`devtools: 'always'`) ships
 * only the launcher in the runtime chunk: this file, the components and their CSS load when someone
 * opens the dock (a dynamic import the bundler splits off). On the dev server it loads at once.
 */
import { mount } from 'svelte';
import Devtools from './Devtools.svelte';
import { install_page_hook } from './page.js';
import { set_highlight_root } from './highlight.js';
import { names as built_names } from 'virtual:ogygia/devtools-meta';

export function mount_app(root: ShadowRoot, opts: { csr_true: boolean; start_open: boolean }): void {
	install_page_hook();
	set_highlight_root(root);
	// a build knows its islands' component names (the dev server serves them live instead)
	if (built_names && Object.keys(built_names).length && typeof window !== 'undefined')
		window.__ogygia_region_names = { ...built_names, ...(window.__ogygia_region_names ?? {}) };
	// `csr_true` = the standalone boot on a Kit-hydrated (csr=true) page, where the ogygia runtime
	// (and its event bus) never ran — the dock renders a notice instead of empty instruments.
	mount(Devtools, { target: root, props: { csrTrue: opts.csr_true, startOpen: opts.start_open } });

	// The components' scoped `<style>`s land in `document.head` — via Svelte's `append_styles` in a
	// production build, or Vite's dev CSS injection in dev — where the shadow boundary blocks them.
	// Relocate ONLY the ones whose scope hash is actually used inside our shadow tree (matched by CSS
	// text, so it works in both dev and prod), never a page or island stylesheet. Keep adopting as tabs
	// and detail views mount their styles later.
	adopt_scoped_styles(root);
	const mo = new MutationObserver(() => adopt_scoped_styles(root));
	mo.observe(document.head, { childList: true });
	mo.observe(root, { childList: true, subtree: true });
}

function adopt_scoped_styles(root: ShadowRoot): void {
	// Every `svelte-xxxxxx` scope class present in our shadow tree.
	const hashes = new Set<string>();
	for (const el of root.querySelectorAll('[class*="svelte-"]')) {
		for (const c of el.classList) if (c.startsWith('svelte-')) hashes.add(c);
	}
	if (hashes.size === 0) return;
	for (const style of document.querySelectorAll('style')) {
		if (style.getRootNode() === root) continue; // already ours
		const css = style.textContent || '';
		for (const h of hashes) {
			if (css.includes(h)) {
				root.appendChild(style); // move it behind the shadow boundary
				break;
			}
		}
	}
}
