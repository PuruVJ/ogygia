// THE DESIGN-SYSTEM SSR PASS, the way a big site has it: a post-SSR HTML middleware that pulls
// every `<ds-*>` element out of the finished document with a regex, renders each one through the
// design system's Stencil `hydrate` package (here Ionic: Stencil-built, `@ionic/core/hydrate`),
// twice (a "websites" layer over a "core" layer, with `<template>`/`<style>` renamed between the
// passes so the second one leaves them alone), splices the results back with `String.replace`, and
// lifts the `<style>` tags out of `<head>` first and back in after — because the renderer would
// otherwise touch them. The CDN script gives the elements their behaviour in the browser.
//
// Written to match the shape it has in production, not to be fast: N renders per page, sequential
// splices over a 2 MB string, regexes over the whole document. The profiler's `instrument` makes
// every render a span and `span` names the phases, so the report can say what this pass costs.
import type { Handle } from '@sveltejs/kit';
import { renderToString as ionicRenderToString, type HydrateResults, type SerializeDocumentOptions } from '@ionic/core/hydrate';
import { instrument, span } from 'ogygia/profiler';

const render = (html: string, options?: SerializeDocumentOptions): Promise<HydrateResults> => ionicRenderToString(html, options);
const renderToString = instrument(render, 'ds.render', (r, html) => ({
	tag: /<(ion-[a-z-]+)/.exec(html)?.[1] ?? 'fragment',
	bytes: r.html?.length ?? 0,
	diagnostics: r.diagnostics?.length ?? 0
}));

// replace tag name for the declarative shadow DOM response to work
export const replaceTagName = (html: string, oldTagName: string, newTagName: string): string => {
	const regex = new RegExp(`(<\\/?\\s*)${oldTagName}(\\s*[^>]*>)`, 'gi');
	return html.replace(regex, `$1${newTagName}$2`);
};

export function getTags(html: string): string[] {
	// open and closing tags are the same; the opening tag may carry attributes
	return html.match(/<ion-([^>\s]+)[^>]*>[\s\S]*?<\/ion-\1>/g) || [];
}

export async function processDsTags(pageHtml: string): Promise<string> {
	let { styleMatches, html } = span('ds.styles.extract', () => extractStyleTags(pageHtml));
	const tags = span('ds.tags', () => getTags(html), (t) => ({ tags: t.length }));

	const rendered = await span(
		'ds.render.all',
		() =>
			Promise.all(
				tags.map(async (tag) => {
					let el = '';
					if (tag.startsWith('<ion-chip') || tag.startsWith('<ion-badge')) {
						// the "websites" layer: rendered, its template/style renamed, then the core pass
						el = await renderToString(tag, { fullDocument: false }).then((r) => r.html || '');
						el = replaceTagName(el, 'template', 'tmp-template');
						el = replaceTagName(el, 'style', 'tmp-style');
						el = await renderToString(el, { fullDocument: false }).then((r) => r.html || '');
						el = replaceTagName(el, 'tmp-template', 'template');
						el = replaceTagName(el, 'tmp-style', 'style');
					} else {
						el = await renderToString(tag, { fullDocument: false }).then((r) => r.html || '');
					}
					return { tag, el };
				})
			),
		(r) => ({ rendered: r.length })
	);

	span('ds.splice', () => {
		for (const { tag, el } of rendered) html = html.replace(tag, el); // one pass over the document per tag
	});

	return span('ds.styles.insert', () => insertStyleTags(html, styleMatches));
}

// ── THE EFFICIENT VERSION (`?ds=fast`) ────────────────────────────────────────────────────────
// The same work, allocating the document once instead of once per tag, and no regex on the hot
// path: the head's styles are cut out by index, every distinct tag is rendered once, the document
// is walked ONCE with indexOf and rebuilt from its pieces, and the styles go back in one slice. The
// profiler's GC attribution named the messy version's `html.replace` as 68% of everything
// allocated on the page; this is the fix it asks for.

/** every `<ion-x …>…</ion-x>` in `html` (the first matching close, like the messy regex), by index */
function findIonTags(html: string): { start: number; end: number; tag: string }[] {
	const out: { start: number; end: number; tag: string }[] = [];
	let i = 0;
	for (;;) {
		const start = html.indexOf('<ion-', i);
		if (start === -1) break;
		let j = start + 5;
		while (j < html.length) {
			const c = html.charCodeAt(j);
			if (c === 62 /* > */ || c === 32 || c === 9 || c === 10 || c === 13 || c === 47 /* / */) break;
			j++;
		}
		const name = html.slice(start + 5, j);
		const open_end = html.indexOf('>', j);
		if (!name || open_end === -1) {
			i = start + 5;
			continue;
		}
		const close = '</ion-' + name + '>';
		const close_at = html.indexOf(close, open_end + 1);
		if (close_at === -1) {
			i = start + 5;
			continue;
		}
		const end = close_at + close.length;
		out.push({ start, end, tag: html.slice(start, end) });
		i = end;
	}
	return out;
}

/** `<template` / `</template` → `<tmp-template` (and back), one pass, no regex */
function renameTags(html: string, from: string, to: string): string {
	const out: string[] = [];
	let last = 0;
	let i = 0;
	const open = '<' + from;
	const close = '</' + from;
	for (;;) {
		const a = html.indexOf(open, i);
		const b = html.indexOf(close, i);
		const at = a === -1 ? b : b === -1 ? a : Math.min(a, b);
		if (at === -1) break;
		const closing = at === b;
		const after = at + (closing ? close.length : open.length);
		const c = html.charCodeAt(after);
		// a tag boundary only: `<templatex` is not `<template`
		if (c === 62 || c === 32 || c === 9 || c === 10 || c === 47) {
			out.push(html.slice(last, at), closing ? '</' + to : '<' + to);
			last = after;
		}
		i = after;
	}
	out.push(html.slice(last));
	return out.join('');
}

async function renderOne(tag: string): Promise<string> {
	let el = '';
	if (tag.startsWith('<ion-chip') || tag.startsWith('<ion-badge')) {
		el = await renderToString(tag, { fullDocument: false }).then((r) => r.html || '');
		el = renameTags(renameTags(el, 'template', 'tmp-template'), 'style', 'tmp-style');
		el = await renderToString(el, { fullDocument: false }).then((r) => r.html || '');
		el = renameTags(renameTags(el, 'tmp-template', 'template'), 'tmp-style', 'style');
	} else el = await renderToString(tag, { fullDocument: false }).then((r) => r.html || '');
	return el;
}

export async function processDsTagsFast(pageHtml: string): Promise<string> {
	// the head's styles, by index: no rewrite of the document
	const { head_start, head_end, styles, head } = span('ds.styles.extract', () => {
		const hs = pageHtml.indexOf('<head');
		const he = hs === -1 ? -1 : pageHtml.indexOf('</head>', hs);
		if (hs === -1 || he === -1) return { head_start: -1, head_end: -1, styles: '', head: '' };
		const head_end = he + '</head>'.length;
		const full = pageHtml.slice(hs, head_end);
		const kept: string[] = [];
		const styles: string[] = [];
		let last = 0;
		for (;;) {
			const s = full.indexOf('<style', last);
			if (s === -1) break;
			const e = full.indexOf('</style>', s);
			if (e === -1) break;
			kept.push(full.slice(last, s));
			styles.push(full.slice(s, e + 8));
			last = e + 8;
		}
		kept.push(full.slice(last));
		return { head_start: hs, head_end, styles: styles.join(''), head: kept.join('') };
	});
	const body_html = head_start === -1 ? pageHtml : pageHtml.slice(head_end);
	const tags = span('ds.tags', () => findIonTags(body_html), (t) => ({ tags: t.length }));
	// render each distinct tag once (a repeated chip renders once and is reused)
	const distinct = [...new Set(tags.map((t) => t.tag))];
	const rendered = new Map(await span('ds.render.all', () => Promise.all(distinct.map(async (t) => [t, await renderOne(t)] as const)), (r) => ({ rendered: r.length, distinct: r.length })));
	// ONE pass: the pieces between the tags and each rendered element, joined once
	const body = span('ds.splice', () => {
		const out: string[] = [];
		let last = 0;
		for (const t of tags) {
			out.push(body_html.slice(last, t.start), rendered.get(t.tag) ?? t.tag);
			last = t.end;
		}
		out.push(body_html.slice(last));
		return out.join('');
	});
	return span('ds.styles.insert', () => {
		if (head_start === -1) return body;
		const at = head.lastIndexOf('</head>');
		return pageHtml.slice(0, head_start) + head.slice(0, at) + styles + head.slice(at) + body;
	});
}

export function extractStyleTags(html: string): { styleMatches: { index: number; style: string }[]; html: string } {
	const styleMatches: { index: number; style: string }[] = [];
	const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
	if (headMatch) {
		const head = headMatch[0];
		const styleTagRegex = /<style[\s\S]*?<\/style>/gi;
		let match: RegExpExecArray | null;
		while ((match = styleTagRegex.exec(head)) !== null) styleMatches.push({ index: match.index, style: match[0] });
		const headWithoutStyles = head.replace(styleTagRegex, '');
		html = html.replace(head, headWithoutStyles);
	}
	return { styleMatches, html };
}

export function insertStyleTags(html: string, styleMatches: { index: number; style: string }[]): string {
	for (const { style } of styleMatches) {
		const insertIndex = html.indexOf('</head>');
		html = insertIndex !== -1 ? html.slice(0, insertIndex) + style + html.slice(insertIndex) : style + html;
	}
	return html;
}

export const ds_ssr: Handle = async ({ event, resolve }) => {
	if (!event.url.pathname.startsWith('/hell')) return resolve(event);
	let doc = '';
	const res = await resolve(event, {
		transformPageChunk: ({ html }) => {
			doc += html;
			return ''; // the chunks are collected; the whole document goes out below
		}
	});
	if (!res.headers.get('content-type')?.includes('text/html')) return res;
	// `?ds=fast` runs the efficient pass; the default stays the messy one the page is here to show.
	// The variant rides on the span so the two reports name it in the compare.
	const fast = event.url.searchParams.get('ds') === 'fast';
	const out = await span('ds.pass', () => (fast ? processDsTagsFast(doc) : processDsTags(doc)), (h) => ({ bytes: h.length, variant: fast ? 'fast' : 'messy' }));
	// a new body: the original length / etag would truncate or mislabel it
	const headers = new Headers(res.headers);
	headers.delete('content-length');
	headers.delete('etag');
	return new Response(out, { status: res.status, headers });
};
