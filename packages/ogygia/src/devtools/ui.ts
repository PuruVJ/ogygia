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

export function install_devtools_ui(): void {
	if (!DEVTOOLS || typeof document === 'undefined' || mounted) return;
	mounted = true;
	mount(Devtools, { target: document.documentElement });
}
