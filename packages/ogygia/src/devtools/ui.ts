/**
 * Mount the devtools UI — one `mount()` of the {@link ./Devtools.svelte root app} (behind the
 * `__OGYGIA_DEVTOOLS__` gate). Called from the runtime boot on a devtools build; the whole UI graph
 * (this file, the components, their scoped CSS) tree-shakes away when devtools is off.
 *
 * The panel mounts on the LIVE page (not an iframe), so its host element carries a **shadow root** for
 * total CSS isolation: host-page globals can't reach in (a stray `.spacer { height: 140vh }` once
 * ballooned the header) and the devtools' own styles can't leak out. Svelte injects each component's
 * scoped styles into the shadow root because the mount target lives inside one. The host is attached to
 * `<html>` (not `<body>`) so a full-body SPA swap never tears the panel out.
 */
import { mount } from 'svelte';
import Devtools from './Devtools.svelte';

const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

let mounted = false;

export function install_devtools_ui(opts?: { csr_true?: boolean }): void {
	if (!DEVTOOLS || typeof document === 'undefined' || mounted) return;
	// Never mount on a profiler page — including the Profiler tab's embedded `/run` iframe. Profiler pages
	// tag themselves with `<meta name="ogygia-devtools" content="off">`; the devtools has no business
	// x-raying its own tooling (and a launcher inside the iframe is nonsense).
	if (document.querySelector('meta[name="ogygia-devtools"][content="off"]')) return;
	mounted = true;
	// A 0×0 fixed host holds the shadow root; the real UI is a fixed, viewport-filling root inside it.
	const host = document.createElement('div');
	host.setAttribute('data-ogygia-devtools-host', '');
	host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0';
	document.documentElement.appendChild(host);
	const root = host.attachShadow({ mode: 'open' });
	// `csr_true` = the standalone boot on a Kit-hydrated (csr=true) page, where the ogygia runtime
	// (and its event bus) never ran — the dock renders a notice instead of empty instruments.
	mount(Devtools, { target: root, props: { csrTrue: opts?.csr_true ?? false } });

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
