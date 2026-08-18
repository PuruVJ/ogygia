import { describe, it, expect } from 'vitest';
import { highlight } from '../src/content/markdown/shiki.js';
import { diff_markers } from '../src/content/markdown/diff.js';

// ─────────────────────────────────────────────────────────────────────────────
// The `+++` / `---` fence dialect (svelte.dev's "change this code" prose form):
// markers strip before Shiki tokenizes, lines class as og-diff-add/remove.
// ─────────────────────────────────────────────────────────────────────────────

const OPTS = { transformers: [diff_markers()] };

describe('diff_markers', () => {
	it('strips the markers and classes the lines', async () => {
		const html = await highlight(
			['let a = 1;', '--- export let count;', "+++ let { count } = $props();", 'a++;'].join('\n'),
			'js',
			OPTS
		);
		expect(html).not.toContain('+++');
		expect(html).not.toContain('---');
		expect(html).toContain('og-diff-add');
		expect(html).toContain('og-diff-remove');
		expect(html).toContain('og-has-diff');
		// the stripped source is what Shiki tokenized — the removed line's code is present, marker-free
		expect(html).toContain('export');
		expect(html).toContain('$props');
	});

	it('is inert on a fence with no markers', async () => {
		const html = await highlight('let a = 1;\na++;', 'js', OPTS);
		expect(html).not.toContain('og-diff');
		expect(html).not.toContain('og-has-diff');
	});

	it('a bare marker marks an added/removed EMPTY line', async () => {
		const html = await highlight(['let a;', '+++'].join('\n'), 'js', OPTS);
		expect(html).toContain('og-diff-add');
		expect(html).not.toContain('+++');
	});

	it('leaves marker-like code alone: no space, no dialect', async () => {
		const html = await highlight('let x = i+++j;\n---x;', 'js', OPTS);
		// `---x;` has no space after the marker — not the dialect (it's real minus-minus-minus code)
		expect(html).not.toContain('og-diff');
	});

	it('skips languages where a leading --- is real syntax (yaml)', async () => {
		const html = await highlight(['---', 'title: hi', '---'].join('\n'), 'yaml', OPTS);
		expect(html).not.toContain('og-diff');
		// the separators survive untouched
		expect(html.match(/---/g)!.length).toBeGreaterThanOrEqual(2);
	});
});
