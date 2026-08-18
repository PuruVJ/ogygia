/**
 * Per-URL Speculation Rules hints — the MPA-mode (`router: false`) legs of `preloadData` /
 * `preloadCode`. With no SPA router there is no swap-readable page cache to warm, and the browser
 * owns navigation — so the honest preload primitives are the platform's: `preloadData(url)`
 * speculates a PRERENDER (Chromium activates it on the real navigation — instant), `preloadCode(url)`
 * a PREFETCH (Firefox supports this leg; a prerender-capable browser treats prefetch as its first
 * stage). Where Speculation Rules are unsupported (Safari) this is a silent no-op — a hint API has
 * no failure mode, and the un-hinted navigation still works.
 *
 * LEAF module: no feature imports (usable from the `$app/navigation` shim without dragging the
 * router graph). List rules (not document rules) so each hint targets exactly the asked URL.
 */
const hinted = new Set<string>();

export function speculate_url(url: string | URL, kind: 'prefetch' | 'prerender'): void {
	if (typeof document === 'undefined') return;
	if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
	let target: URL;
	try {
		target = new URL(url, location.href);
	} catch {
		return;
	}
	if (target.origin !== location.origin) return;
	const href = target.pathname + target.search;
	const key = kind + '\0' + href;
	if (hinted.has(key)) return;
	hinted.add(key);
	const script = document.createElement('script');
	script.type = 'speculationrules';
	script.setAttribute('data-ogygia-speculate-hint', '');
	script.textContent = JSON.stringify({ [kind]: [{ urls: [href] }] });
	document.head.appendChild(script);
}
