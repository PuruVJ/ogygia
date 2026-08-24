/**
 * Mount the devtools UI — one `mount()` of the {@link ./Devtools.svelte root app} (behind the
 * `__OGYGIA_DEVTOOLS__` gate). Called from the runtime boot on a devtools build; the whole UI graph
 * (this file, the components, their scoped CSS) tree-shakes away when devtools is off.
 *
 * Mounted onto `<html>` (not `<body>`) so a full-body SPA swap never tears the panel out.
 */
import { mount } from 'svelte';
import Devtools from './Devtools.svelte';

const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

let mounted = false;

export function install_devtools_ui(opts?: { csr_true?: boolean }): void {
	if (!DEVTOOLS || typeof document === 'undefined' || mounted) return;
	mounted = true;
	// `csr_true` = the standalone boot on a Kit-hydrated (csr=true) page, where the ogygia runtime
	// (and its event bus) never ran — the dock renders a notice instead of empty instruments.
	mount(Devtools, { target: document.documentElement, props: { csrTrue: opts?.csr_true ?? false } });
}
