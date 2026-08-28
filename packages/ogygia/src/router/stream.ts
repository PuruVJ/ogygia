/**
 * STREAMED PAGES — `page(async function* (c, data) { yield region(...); ... })`.
 *
 * "The next state of a slot is a region" is the house law (`query.live` yields regions over the
 * push channel); this is the same vocabulary on the INITIAL response: the FIRST yield renders in
 * the document and the page flushes immediately; every later yield rides down the SAME response
 * as an inert `<template data-og-late>` chunk that swaps into the slot as it parses. One
 * connection, closed when the generator ends — no SSE, no second round trip, and no Svelte
 * streaming needed: each yield is an ordinary synchronous render, only the DOCUMENT is chunked.
 *
 * Islands inside late chunks need no orchestration: `<ogygia-region>` is a custom element, so
 * the moment swapped content lands in the DOM it upgrades, connects, and wakes on its own
 * schedule — the runtime never has to be told.
 *
 * Swapping is driven by ONE small classic inline script in the head (module scripts don't run
 * until parsing ENDS, which for a streamed document is the very thing we're not waiting for).
 * Same CSP posture as ogygia's existing `script()` head primitive. SPA navigations fetch the
 * COMPLETED stream, so there the runtime applies remaining templates after the body swap.
 *
 * Streaming's honest trades (documented): status/title/headers flush with the first yield — a
 * late error can't change an already-sent 200, and Server-Timing set after the flush is lost.
 */

/** The slot id for the page position (one streamed slot per page in v1). */
export const PAGE_SLOT_ID = 'pg';

/** Wrap the FIRST yield's html as the swappable slot (display:contents — layout-invisible). */
export function slot_html(id: string, html: string): string {
	return `<og-late-slot data-og-slot="${id}" style="display:contents">${html}</og-late-slot>`;
}

/** A late chunk: inert template + nothing else — the boot script (or the runtime, post-SPA-swap)
 *  performs the swap. Multiple chunks for one slot apply in order (progressive states). */
export function late_chunk(id: string, html: string): string {
	return `<template data-og-late="${id}">${html}</template>`;
}

/**
 * The classic inline boot: observes streamed-in `<template data-og-late>` nodes DURING parse and
 * swaps each into its slot immediately (stylesheet links hoist to head first so the swap never
 * paints unstyled). Kept dependency-free and tiny — it must run before any module script can.
 */
export const LATE_BOOT_SCRIPT =
	'<script data-og-late-boot>(function(){' +
	'function ap(t){var id=t.getAttribute("data-og-late");var s=document.querySelector(' +
	"'og-late-slot[data-og-slot=\"'+id+'\"]');if(!s){t.remove();return}" +
	'var c=t.content;var ls=c.querySelectorAll(\'link[rel="stylesheet"],style\');' +
	'for(var i=0;i<ls.length;i++){var l=ls[i];var h=l.getAttribute&&l.getAttribute("href");' +
	"if(h&&document.head.querySelector('link[href=\"'+h+'\"]'))l.remove();" +
	'else document.head.appendChild(l)}' +
	'while(s.firstChild)s.removeChild(s.firstChild);s.appendChild(c);t.remove()}' +
	'var mo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ad=ms[i].addedNodes;' +
	'for(var j=0;j<ad.length;j++){var n=ad[j];if(n.nodeType===1&&n.tagName==="TEMPLATE"&&' +
	'n.hasAttribute("data-og-late"))ap(n)}}});' +
	'mo.observe(document.documentElement,{childList:true,subtree:true});' +
	'addEventListener("DOMContentLoaded",function(){' +
	'var ts=document.querySelectorAll("template[data-og-late]");' +
	'for(var i=0;i<ts.length;i++)ap(ts[i]);mo.disconnect()},{once:true});' +
	'})()</script>';

/** Bake ANY yielded value to html: a string passes through, an inline region carries its html,
 *  a component/held region AWAITS into its bake (island shells + prefixed CSS links included —
 *  the same path `catalog()` widgets take). */
export async function bake_yield(v: unknown): Promise<string> {
	if (typeof v === 'string') return v;
	if (v && typeof v === 'object') {
		const o = v as {
			kind?: string;
			html?: unknown;
			props?: { html?: unknown };
			then?: unknown;
		};
		// A still-thenable region (yielded from a SYNC generator, or handed in directly): bake it.
		// NOTE an ASYNC generator's `yield` awaits thenables ITSELF, so the usual arrival here is
		// the RESOLVED shape — `{ kind, html }` with the bake done (this bit the e2e while the
		// string-only unit tests stayed green: test the real shapes).
		if (typeof o.then === 'function') return bake_yield(await (v as PromiseLike<unknown>));
		// resolved inline/dual carry top-level `html`; a raw og_html_region carries `props.html`
		const html = o.html ?? o.props?.html;
		if (html != null) return String(html);
		if (o.kind != null)
			// a region with NO html after resolution: an unmarked import in a server-only module
			// bakes nothing (no identity, no client leg — the round-1 `region: 'raw'` rule).
			throw new Error(
				"[ogygia/router] a yielded region did not bake — mark its import (`with { region: 'raw' }` or a wake) so the component has an identity + client leg."
			);
	}
	throw new Error(
		'[ogygia/router] a streamed page must yield regions (region(C, props) / og_html_region(html)) or html strings.'
	);
}

/** Is this page slot an async-generator function? (Svelte components are plain functions —
 *  never async generators — so this discriminator needs no brand.) */
export function is_stream_slot(v: unknown): v is (...args: never[]) => AsyncGenerator<unknown> {
	return Object.prototype.toString.call(v) === '[object AsyncGeneratorFunction]';
}

const HEAD_CLOSE_RE = /<\/head>/i;

/**
 * Turn a fully-rendered document (first yield in place) + the generator's REMAINING yields into
 * a streamed Response: flush everything up to `</body>` now, append one template chunk per
 * later yield, then the tail. A generator throw after the flush becomes an inline error-card
 * chunk (the page must never end broken) — the status is already on the wire, which is
 * streaming's documented trade.
 */
export function stream_document(
	full_html: string,
	res: Response,
	rest: AsyncGenerator<unknown>,
	slot_id: string
): Response {
	const with_boot = full_html.replace(HEAD_CLOSE_RE, LATE_BOOT_SCRIPT + '</head>');
	const cut = with_boot.lastIndexOf('</body>');
	const head_part = cut === -1 ? with_boot : with_boot.slice(0, cut);
	const tail_part = cut === -1 ? '' : with_boot.slice(cut);
	const enc = new TextEncoder();

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(enc.encode(head_part));
			try {
				for (;;) {
					const n = await rest.next();
					if (n.done) break;
					controller.enqueue(enc.encode(late_chunk(slot_id, await bake_yield(n.value))));
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				controller.enqueue(
					enc.encode(
						late_chunk(
							slot_id,
							`<div data-og-late-error style="border:1px dashed #dc2626;border-radius:8px;padding:1rem;color:#dc2626">` +
								`This section failed to load. ${escape_text(msg)}</div>`
						)
					)
				);
			}
			controller.enqueue(enc.encode(tail_part));
			controller.close();
		}
	});

	const headers = new Headers(res.headers);
	headers.delete('content-length'); // a stream has none — a stale length truncates the document
	// no-transform: compressing intermediaries (CDNs, vite preview's gzip) BUFFER while they
	// compress, which collapses the stream back into one late paint — the flushed-first-chunk
	// point of this response. The standard header tells them to pass bytes through as-is.
	const cc = headers.get('cache-control');
	if (!cc) headers.set('cache-control', 'no-transform');
	else if (!/no-transform/i.test(cc)) headers.set('cache-control', `${cc}, no-transform`);
	return new Response(body, { status: res.status, headers });
}

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const escape_text = (s: string) =>
	s.replace(AMP_RE, '&amp;').replace(LT_RE, '&lt;').replace(GT_RE, '&gt;');
