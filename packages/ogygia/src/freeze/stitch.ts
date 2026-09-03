/**
 * freeze — SERVE-TIME STITCHING (the zero-flash upgrade over `render: 'live'`).
 *
 * A `with { render: 'deferred', stitch: 'serve' }` hole ships in the stored shell as a normal
 * signed hole PLUS a `stitch` attribute. On every serve of that entry the handle renders the
 * hole server-side RIGHT THEN (the visitor's cookies ride the request) and SPLICES the HTML
 * into the stored bytes — one response, personalized first paint, view-source included.
 *
 * Laws: fail-open PER HOLE (a failed/timed-out render keeps the fallback + the client fetch —
 * a slow upstream never blocks the page); the spliced wrapper becomes a neutral
 * `display:contents` div so nested islands inside the stitched HTML are TOP-LEVEL regions that
 * wake themselves (no region ancestor to ride or wait on); stitched entries are per-visitor —
 * the capture stamps them `private, no-store` and mints no validators.
 *
 * Pure string functions (unit-tested); the handle threads its own `#render_capability`.
 */

/** Cheap presence probe — the capture uses it to flag entries; serves use it to skip the scan. */
export const STITCH_HOLE_RE = /<ogygia-region\b[^>]*\bstitch\b[^>]*>/;

// Hoisted tokens for the balanced scan (regions NEST — a hole's fallback can contain regions).
const REGION_TOKEN_RE = /<ogygia-region\b[^>]*>|<\/ogygia-region>/g;
const STITCH_ATTR_RE = /\bstitch\b/;
/** `stitch="edge"` — the ESI mode. Anything else that carries `stitch` (`"serve"`, or the bare
 *  attribute an older build emitted) is the origin-serve mode. */
const STITCH_EDGE_RE = /\bstitch="edge"/;
const ENDPOINT_ATTR_RE = /\bendpoint="([^"]*)"/;
const AMP_RE = /&amp;/g;
const ATTR_AMP_G = /&/g;
const ATTR_QUOTE_G = /"/g;

/** How a stitch hole fills: `'serve'` = the ORIGIN re-renders + splices on every serve (per-visitor
 *  page, edge-bypassed) · `'edge'` = the CDN fills an ESI include per request (the shell stays
 *  edge-cached; origin renders only the hole). */
export type StitchMode = 'serve' | 'edge';

export interface StitchHole {
	/** Absolute span of the WHOLE region block (open tag through matching close). */
	start: number;
	end: number;
	/** The signed capability URL from the `endpoint` attribute, entity-unescaped. */
	endpoint: string;
	mode: StitchMode;
}

/** Which stitch modes a stored page carries. One `'serve'` hole makes the WHOLE page per-visitor
 *  (serve taints); a page whose stitch holes are all `'edge'` stays edge-cacheable. */
export function stitch_modes(html: string): { serve: boolean; edge: boolean } {
	if (!STITCH_HOLE_RE.test(html)) return { serve: false, edge: false };
	const holes = find_stitch_holes(html);
	return {
		serve: holes.some((h) => h.mode === 'serve'),
		edge: holes.some((h) => h.mode === 'edge')
	};
}

/**
 * EDGE STITCHING (ESI): rewrite every `stitch="edge"` hole so an ESI-capable CDN (Akamai, Fastly,
 * Varnish) fills it per request from the hole's own signed capability, while the shell around it
 * stays cached at the edge. The region block is wrapped in `<esi:remove>` and followed by an
 * `<esi:include>`:
 *   - on an ESI edge the wrapper is stripped and the include is fetched from origin (with the
 *     viewer's cookies, per the edge config) → a personal first paint, shell served from cache,
 *     origin renders ONE region;
 *   - anywhere ESI is not processed (direct origin, dev, a non-ESI CDN) `<esi:remove>` is an
 *     unknown element whose CHILDREN still render and `<esi:include>` is inert — the hole ships its
 *     fallback and the client fetches it exactly like a normal deferred hole. Graceful either way.
 * Pure string function; the capture runs it at store time (the etag is minted over the result).
 * `page_path` is the stored page's pathname: the hole's endpoint is emitted PAGE-RELATIVE
 * (`../../__ogygia__?…` under Kit's relative paths), and an ESI include must be an absolute path
 * the edge can fetch from origin without knowing the page — so each src is resolved here.
 */
export function esi_rewrite(html: string, page_path = '/'): string {
	const holes = find_stitch_holes(html).filter((h) => h.mode === 'edge');
	if (!holes.length) return html;
	let out = '';
	let last = 0;
	for (const h of holes) {
		const abs = new URL(h.endpoint, 'http://o' + page_path);
		const src = (abs.pathname + abs.search)
			.replace(ATTR_AMP_G, '&amp;')
			.replace(ATTR_QUOTE_G, '&quot;');
		out += html.slice(last, h.start);
		out += `<esi:remove>${html.slice(h.start, h.end)}</esi:remove><esi:include src="${src}" onerror="continue"/>`;
		last = h.end;
	}
	out += html.slice(last);
	return out;
}

/** Find every TOP-LEVEL stitch-marked region block, balanced across nested regions. */
export function find_stitch_holes(html: string): StitchHole[] {
	const holes: StitchHole[] = [];
	let depth = 0;
	let open: { start: number; tag: string } | null = null;
	REGION_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REGION_TOKEN_RE.exec(html))) {
		const token = m[0];
		if (token[1] === '/') {
			depth--;
			if (depth === 0 && open) {
				if (STITCH_ATTR_RE.test(open.tag)) {
					const endpoint = ENDPOINT_ATTR_RE.exec(open.tag)?.[1]?.replace(AMP_RE, '&') ?? '';
					if (endpoint)
						holes.push({
							start: open.start,
							end: m.index + token.length,
							endpoint,
							mode: STITCH_EDGE_RE.test(open.tag) ? 'edge' : 'serve'
						});
				}
				open = null;
			}
		} else {
			if (depth === 0) open = { start: m.index, tag: token };
			depth++;
		}
	}
	return holes;
}

/**
 * Splice fresh renders into every stitch hole. `render` resolves an endpoint to HTML or null;
 * null (failure/timeout) keeps the original block VERBATIM — the fallback ships and the client
 * fetches exactly as an unstitched hole would (fail-open). Holes render in PARALLEL.
 */
export async function stitch_html(
	html: string,
	render: (endpoint: string) => Promise<string | null>
): Promise<string> {
	const holes = find_stitch_holes(html);
	if (!holes.length) return html;
	const rendered = await Promise.all(holes.map((h) => render(h.endpoint).catch(() => null)));
	let out = '';
	let last = 0;
	for (let i = 0; i < holes.length; i++) {
		const fill = rendered[i];
		if (fill === null) continue; // fail-open: leave the block untouched
		out += html.slice(last, holes[i].start);
		out += `<div style="display:contents" data-og-stitched="">${fill}</div>`;
		last = holes[i].end;
	}
	out += html.slice(last);
	return out;
}
