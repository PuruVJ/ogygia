<script lang="ts">
	/**
	 * Code-block chrome — a copy button AND a permalink on every `<pre>` in the doc body. An ISLAND
	 * (`with { wake: 'load' }`): it hydrates per page and RE-hydrates after every SPA navigation, so the
	 * buttons come back on the new page — the inline-script version's observer was scoped to the old
	 * `.og-body` and died on a body swap. The work lives in an ATTACHMENT on a hidden anchor; a
	 * MutationObserver re-enhances blocks that a live-island region re-inserts. Idempotent per `<pre>`.
	 *
	 * The permalink: each block gets a stable id (nearest heading id + an index within that section, e.g.
	 * `installation-code-2`), and the link button copies the full `#`-anchored URL and jumps to it — the
	 * same "grab a link to exactly this" affordance the heading anchors give.
	 */
	let { selector = '.og-body pre' }: { selector?: string } = $props();

	const COPY =
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
	const CHECK =
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
	const LINK =
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

	/** Attachment: enhance every `<pre>`, then watch the doc body for late-inserted blocks. */
	function chrome(anchor: HTMLElement) {
		const root = (anchor.closest('.og-doc') || anchor.parentElement || document.body) as Element;
		// Focus the deep-link target so an accent ring lands the eye — and CLEARS on blur (unlike a sticky
		// `:target`). The class gates the ring to permalink jumps, not stray clicks. `preventScroll` since
		// the `#`-hash navigation already scrolled it into view (respecting scroll-margin).
		function focus_target(el: HTMLElement) {
			el.tabIndex = -1;
			el.classList.add('og-target-focus');
			el.focus({ preventScroll: true });
			const off = () => {
				el.classList.remove('og-target-focus');
				el.removeEventListener('blur', off);
			};
			el.addEventListener('blur', off);
		}

		/** Nearest heading id in document order that PRECEDES this `<pre>` (robust to nesting). */
		function section_id(pre: Element): string | null {
			const headings = root.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
			let found: string | null = null;
			for (const h of headings) {
				if (h.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING) found = h.id;
				else break;
			}
			return found;
		}

		// FNV-1a → base36 (mirrors the build-time `remark-code-ids` hash, so a fallback id matches).
		function hash_code(text: string): string {
			let h = 2166136261;
			for (let i = 0; i < text.length; i++) {
				h ^= text.charCodeAt(i);
				h = Math.imul(h, 16777619);
			}
			return (h >>> 0).toString(36);
		}

		// Build-time `remark-code-ids` already gave every block a stable `slug-code-<hash>` id in the SSR
		// HTML — this only fires for blocks a live region inserts after load, matching the same scheme.
		function assign_id(pre: Element): string {
			if (pre.id) return pre.id;
			const sec = section_id(pre);
			const text = ((pre.querySelector('code') || pre).textContent ?? '').replace(/\s+/g, ' ').trim();
			const h = hash_code(text);
			const base = sec ? `${sec}-code-${h}` : `code-${h}`;
			let id = base;
			let n = 2;
			while (document.getElementById(id)) id = `${base}-${n++}`;
			pre.id = id;
			return id;
		}

		function enhance(pre: Element) {
			if ((pre as { __ogc?: boolean }).__ogc) return;
			// Skip HIDDEN code blocks — a `<pre>` that isn't laid out is chrome-in-chrome (a twoslash
			// hover popup's baked code, a collapsed variant), not a doc block; copy/permalink don't
			// belong on it. `offsetParent === null` catches `display:none` ancestors generically.
			if ((pre as HTMLElement).offsetParent === null) return;
			(pre as { __ogc?: boolean }).__ogc = true;
			const id = assign_id(pre);

			const actions = document.createElement('div');
			actions.className = 'og-code-actions';

			// Permalink — copy the `#`-anchored URL, jump to the block, flash a tick.
			const link = document.createElement('a');
			link.className = 'og-code-link';
			link.href = `#${id}`;
			link.setAttribute('aria-label', 'Copy link to this code block');
			link.innerHTML = LINK;
			link.addEventListener('click', () => {
				focus_target(pre as HTMLElement); // land the reader's eye on the block (ring clears on blur)
				const url = `${location.origin}${location.pathname}#${id}`;
				navigator.clipboard?.writeText(url).then(
					() => {
						link.setAttribute('data-linked', '1');
						link.innerHTML = CHECK;
						setTimeout(() => {
							link.removeAttribute('data-linked');
							link.innerHTML = LINK;
						}, 1500);
					},
					() => {}
				);
			});

			// Copy the code text.
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'og-copy';
			btn.setAttribute('aria-label', 'Copy code');
			btn.innerHTML = COPY;
			btn.addEventListener('click', () => {
				const code = pre.querySelector('code') || pre;
				const text = (code as HTMLElement).innerText || code.textContent || '';
				if (!navigator.clipboard) return;
				navigator.clipboard.writeText(text).then(() => {
					pre.setAttribute('data-copied', '1');
					btn.innerHTML = CHECK;
					setTimeout(() => {
						pre.removeAttribute('data-copied');
						btn.innerHTML = COPY;
					}, 1500);
				});
			});

			actions.appendChild(link);
			actions.appendChild(btn);
			pre.appendChild(actions);
		}
		const scan = () => document.querySelectorAll(selector).forEach(enhance);
		scan();
		const mo =
			typeof MutationObserver !== 'undefined' ? new MutationObserver(() => scan()) : null;
		// `childList` catches blocks a live region inserts; `hidden`/`open` catch a block REVEALED
		// after load — a `::: code-group` tab switch (the panel's `hidden` toggles) or a `::: details`
		// opening. `enhance` skips hidden `<pre>`s (`offsetParent === null`) at first scan, so without
		// this a newly-shown tab would carry no copy/permalink. `scan` is idempotent (`__ogc` guard).
		mo?.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['hidden', 'open']
		});

		// Heading permalinks (the rehype-added `.og-heading-anchor`) are plain `<a href="#id">` with no
		// island of their own — delegate here so following one also focuses its heading, same as a code
		// block. The hash nav handles the scroll; we just add the ring.
		const on_click = (e: Event) => {
			const t = e.target as Element | null;
			const a = t?.closest?.('.og-heading-anchor');
			if (!a) return;
			const h = a.closest('h1, h2, h3, h4, h5, h6') as HTMLElement | null;
			if (h) focus_target(h);
		};
		root.addEventListener('click', on_click);

		return () => {
			mo?.disconnect();
			root.removeEventListener('click', on_click);
		};
	}
</script>

<span class="og-code-chrome" aria-hidden="true" hidden {@attach chrome}></span>
