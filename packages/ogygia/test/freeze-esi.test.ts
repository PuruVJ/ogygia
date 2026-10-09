/**
 * EDGE stitching (ESI) — freeze/stitch.ts: `stitch="edge"` holes are rewritten at store time into
 * `<esi:remove>…</esi:remove><esi:include src=…/>` so an ESI-capable CDN fills them per request
 * while the shell stays edge-cached; one `stitch="serve"` hole taints the page to origin-serve.
 */
import { describe, it, expect } from 'vitest';
import { find_stitch_holes, stitch_modes, esi_rewrite } from '../src/freeze/stitch.js';

const hole = (mode: '' | 'serve' | 'edge', endpoint: string, inner = 'fb') =>
	`<ogygia-region entry="" render="defer" when="load"${
		mode === '' ? '' : ` stitch="${mode}"`
	} endpoint="${endpoint}">${inner}</ogygia-region>`;

describe('freeze/stitch — modes', () => {
	it('reads the mode off the attribute; a bare `stitch` (older emit) is serve', () => {
		const html = hole('edge', '/e1') + hole('serve', '/e2') + hole('', '/e3');
		const holes = find_stitch_holes(html);
		expect(holes.map((h) => h.mode)).toEqual(['edge', 'serve']);
		const legacy = `<ogygia-region render="defer" stitch endpoint="/x">fb</ogygia-region>`;
		expect(find_stitch_holes(legacy)[0].mode).toBe('serve');
	});

	it('stitch_modes: none / edge-only / serve taints', () => {
		expect(stitch_modes('<p>plain</p>')).toEqual({ serve: false, edge: false });
		expect(stitch_modes(hole('edge', '/e'))).toEqual({ serve: false, edge: true });
		expect(stitch_modes(hole('edge', '/e') + hole('serve', '/s'))).toEqual({
			serve: true,
			edge: true
		});
	});
});

describe('freeze/stitch — esi_rewrite', () => {
	it('wraps an edge hole in esi:remove and follows it with an esi:include of its capability', () => {
		const ep = '/__ogygia__?id=abc&amp;props=p&amp;exp=1&amp;sig=s';
		const html = `<main>${hole('edge', ep, '<p data-stitch-fallback>loading</p>')}</main>`;
		const out = esi_rewrite(html);
		expect(out.startsWith('<main><esi:remove><ogygia-region')).toBe(true);
		expect(out).toContain('</ogygia-region></esi:remove><esi:include src="');
		// the include src is the UNESCAPED endpoint re-escaped for an XML attribute
		expect(out).toContain(
			'src="/__ogygia__?id=abc&amp;props=p&amp;exp=1&amp;sig=s" onerror="continue"/>'
		);
		// the fallback survives inside the wrapper (renders where ESI is not processed)
		expect(out).toContain('<p data-stitch-fallback>loading</p>');
		expect(out.endsWith('</main>')).toBe(true);
	});

	it('resolves a PAGE-RELATIVE endpoint (Kit relative paths) to an absolute include src', () => {
		const html = hole('edge', '../../__ogygia__?id=abc&amp;sig=s');
		const out = esi_rewrite(html, '/fr/fr/esi');
		expect(out).toContain('<esi:include src="/__ogygia__?id=abc&amp;sig=s" onerror="continue"/>');
		// under a nested page the same relative form resolves the same way
		expect(esi_rewrite(html, '/a/b/c')).toContain('src="/__ogygia__?id=abc&amp;sig=s"');
	});

	it('leaves serve holes and plain html untouched', () => {
		const html = `<a>${hole('serve', '/s')}</a>`;
		expect(esi_rewrite(html)).toBe(html);
		expect(esi_rewrite('<p>x</p>')).toBe('<p>x</p>');
	});

	it('rewrites only the edge holes on a mixed page (serve taints at the capture, not here)', () => {
		const html = hole('edge', '/e') + hole('serve', '/s');
		const out = esi_rewrite(html);
		expect(out.match(/<esi:include/g)).toHaveLength(1);
		expect(out).toContain(hole('serve', '/s'));
	});

	it('balances NESTED regions inside an edge hole (a fallback can contain regions)', () => {
		const inner = `<ogygia-region render="defer" endpoint="/n">nested</ogygia-region>`;
		const html = hole('edge', '/e', inner) + '<footer/>';
		const out = esi_rewrite(html);
		expect(out.match(/<esi:remove>/g)).toHaveLength(1);
		expect(out).toContain(`${inner}</ogygia-region></esi:remove>`);
		expect(out.endsWith('<footer/>')).toBe(true);
	});
});
