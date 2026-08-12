// Dynamic OG images. The card is a self-contained Svelte component rendered to HTML on the server
// (`svelte/server` `render`), converted to a satori node tree, rasterised to PNG by resvg. Fonts are
// loaded with SvelteKit's `read()` on imported assets so they are bundled + traced on every adapter
// (a plain fs read from node_modules is dropped by @vercel/nft on serverless).
import { read } from '$app/server';
import { render } from 'svelte/server';
import satori from 'satori';
import { html as toSatori } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import OgCard from '$lib/og/OgCard.svelte';

import NewsreaderNormal from '@fontsource/newsreader/files/newsreader-latin-600-normal.woff';
import NewsreaderItalic from '@fontsource/newsreader/files/newsreader-latin-600-italic.woff';
import Mono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff';

import type { RequestHandler } from './$types';

// Dynamic per request (title/category vary); never prerender this endpoint.
export const prerender = false;

let fonts_promise: Promise<
	{ name: string; data: ArrayBuffer; weight: 500 | 600; style: 'normal' | 'italic' }[]
> | null = null;

function load_fonts() {
	fonts_promise ??= Promise.all([
		read(NewsreaderNormal).arrayBuffer(),
		read(NewsreaderItalic).arrayBuffer(),
		read(Mono).arrayBuffer()
	]).then(([normal, italic, mono]) => [
		{ name: 'Newsreader', data: normal, weight: 600 as const, style: 'normal' as const },
		{ name: 'Newsreader', data: italic, weight: 600 as const, style: 'italic' as const },
		{ name: 'JetBrains Mono', data: mono, weight: 500 as const, style: 'normal' as const }
	]);
	return fonts_promise;
}

export const GET: RequestHandler = async ({ url }) => {
	const home = url.searchParams.get('home') === '1';
	const title = url.searchParams.get('title') || 'SSR islands for SvelteKit';
	const category = url.searchParams.get('category') || '';

	// Svelte escapes text (`&` → `&amp;`), and satori-html doesn't decode entities — so a title like
	// "SPA router & PPR" would render the literal `&amp;`. Decode the safe text entities here. `&lt;`/
	// `&gt;` are left escaped so a stray `<` in a title can't reopen the markup satori-html re-parses.
	// `css="injected"` puts scoped CSS in `head` as a <style> block; markup is in `body`. satori
	// resolves the scoped class selectors when handed both together.
	const rendered = render(OgCard, { props: { title, category, home } });
	const decoded = (rendered.head + rendered.body)
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&');
	const markup = toSatori(decoded);

	const svg = await satori(markup, { width: 1200, height: 630, fonts: await load_fonts() });
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

	return new Response(new Uint8Array(png), {
		headers: {
			'content-type': 'image/png',
			// crawlers hit this once and cache; the CDN holds it, the browser re-checks hourly
			'cache-control': 'public, max-age=3600, s-maxage=604800'
		}
	});
};
