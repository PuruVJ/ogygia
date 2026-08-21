import { describe, expect, it } from 'vitest';
import {
	is_awake,
	is_deferred,
	is_frozen,
	phase2_hydrate_schedule,
	region_hydrate_schedule,
	region_is_vacant,
	region_max_age_ms,
	region_on_expire,
	region_remount,
	region_schedule,
	region_ssr_truncated
} from '../src/runtime/region-attrs.js';

/** Minimal Element-like for attribute helpers (no DOM env). */
class FakeEl {
	constructor(readonly attrs: Record<string, string> = {}) {}
	getAttribute(name: string) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name]! : null;
	}
}

/** Minimal ParentNode-like for vacancy checks. */
class FakeParent {
	constructor(readonly childNodes: Array<{ nodeType: number; textContent?: string }>) {}
}

describe('region-attrs (two-axis DOM)', () => {
	it('is_awake only for hydrate schedules, not none', () => {
		expect(is_awake(new FakeEl({ wake: 'load' }))).toBe(true);
		expect(is_awake(new FakeEl({ wake: 'idle' }))).toBe(true);
		expect(is_awake(new FakeEl({ wake: '(max-width: 600px)' }))).toBe(true);
		expect(is_awake(new FakeEl({ wake: 'none' }))).toBe(false);
		expect(is_awake(new FakeEl({ render: 'defer', when: 'load' }))).toBe(false);
	});

	it('is_frozen matches hydrate="none"', () => {
		expect(is_frozen(new FakeEl({ wake: 'none' }))).toBe(true);
		expect(is_frozen(new FakeEl({ wake: 'load' }))).toBe(false);
		expect(is_frozen(new FakeEl({}))).toBe(false);
	});

	it('region_remount defaults to cache', () => {
		expect(region_remount(new FakeEl({ wake: 'none' }))).toBe('cache');
		expect(region_remount(new FakeEl({ remount: 'cache' }))).toBe('cache');
		expect(region_remount(new FakeEl({ remount: 'empty' }))).toBe('empty');
		expect(region_remount(new FakeEl({ remount: 'swr' }))).toBe('swr');
	});

	it('region_max_age_ms / region_on_expire', () => {
		expect(region_max_age_ms(new FakeEl({}))).toBe(0);
		expect(region_max_age_ms(new FakeEl({ 'max-age': '5000' }))).toBe(5000);
		expect(region_on_expire(new FakeEl({ remount: 'cache' }))).toBe('empty');
		expect(region_on_expire(new FakeEl({ remount: 'swr' }))).toBe('fetch');
		expect(region_on_expire(new FakeEl({ remount: 'swr', 'on-expire': 'empty' }))).toBe('empty');
	});

	it('region_is_vacant treats comments/whitespace as empty but text/elements as filled', () => {
		expect(region_is_vacant(new FakeParent([]) as unknown as ParentNode)).toBe(true);
		expect(
			region_is_vacant(
				new FakeParent([
					{ nodeType: 8 },
					{ nodeType: 3, textContent: '  \n' }
				]) as unknown as ParentNode
			)
		).toBe(true);
		expect(
			region_is_vacant(
				new FakeParent([{ nodeType: 3, textContent: 'frozen text' }]) as unknown as ParentNode
			)
		).toBe(false);
		expect(region_is_vacant(new FakeParent([{ nodeType: 1 }]) as unknown as ParentNode)).toBe(
			false
		);
	});

	it('is_deferred / region_schedule use render+when', () => {
		const hole = new FakeEl({ render: 'defer', when: 'visible' });
		expect(is_deferred(hole)).toBe(true);
		expect(region_schedule(hole)).toBe('visible');
		expect(region_schedule(new FakeEl({ render: 'defer' }))).toBe('load');
		expect(region_schedule(new FakeEl({ wake: 'idle' }))).toBe('idle');
		// frozen regions don't schedule a wake; default load is unused for them
		expect(region_schedule(new FakeEl({ wake: 'none' }))).toBe('load');
	});

	it('region_hydrate_schedule / phase2 coalesce', () => {
		expect(region_hydrate_schedule(new FakeEl({ render: 'defer', when: 'load' }))).toBe(null);
		expect(
			region_hydrate_schedule(new FakeEl({ render: 'defer', when: 'visible', wake: 'idle' }))
		).toBe('idle');
		expect(region_hydrate_schedule(new FakeEl({ wake: 'none' }))).toBe(null);

		// Matching schedules → immediate phase-2 load (no re-arm)
		expect(phase2_hydrate_schedule('load', 'load')).toBe('load');
		expect(phase2_hydrate_schedule('idle', 'idle')).toBe('load');
		expect(phase2_hydrate_schedule('visible', 'visible')).toBe('load');
		expect(phase2_hydrate_schedule('(min-width: 700px)', '(min-width: 700px)')).toBe('load');
		// hydrate:load after any defer → ASAP
		expect(phase2_hydrate_schedule('visible', 'load')).toBe('load');
		expect(phase2_hydrate_schedule('idle', 'load')).toBe('load');
		// Stricter/later hydrate keeps its schedule
		expect(phase2_hydrate_schedule('load', 'visible')).toBe('visible');
		expect(phase2_hydrate_schedule('visible', 'idle')).toBe('idle');
		expect(phase2_hydrate_schedule('load', '(max-width: 600px)')).toBe('(max-width: 600px)');
	});

	it('deferred client island: awake + deferred axes together', () => {
		const combo = new FakeEl({
			render: 'defer',
			when: 'load',
			wake: 'visible',
			'hydrate-margin': '100px'
		});
		expect(is_deferred(combo)).toBe(true);
		expect(is_awake(combo)).toBe(true);
		expect(region_schedule(combo)).toBe('load'); // phase-1 uses when
		expect(region_hydrate_schedule(combo)).toBe('visible');
		expect(phase2_hydrate_schedule(region_schedule(combo), region_hydrate_schedule(combo)!)).toBe(
			'visible'
		);
	});

	it('phase2: defer:load + hydrate:idle|visible arms second schedule (no coalesce)', () => {
		expect(phase2_hydrate_schedule('load', 'idle')).toBe('idle');
		expect(phase2_hydrate_schedule('load', 'visible')).toBe('visible');
		expect(phase2_hydrate_schedule('idle', 'visible')).toBe('visible');
		expect(phase2_hydrate_schedule('visible', '(min-width: 500px)')).toBe('(min-width: 500px)');
	});

	it('phase2: modulepreload eligibility mirrors coalesce (hydrate load OR match)', () => {
		// ServerIsland wants_modulepreload ≡ hydrate==='load' || hydrate===defer
		const wants = (defer: string, hydrate: string) => hydrate === 'load' || hydrate === defer;
		expect(wants('load', 'load')).toBe(true);
		expect(wants('idle', 'idle')).toBe(true);
		expect(wants('visible', 'visible')).toBe(true);
		expect(wants('idle', 'load')).toBe(true);
		expect(wants('load', 'visible')).toBe(false);
		expect(wants('load', 'idle')).toBe(false);
		// And those cases map to phase2 'load' (immediate after swap)
		expect(phase2_hydrate_schedule('idle', 'idle')).toBe('load');
		expect(phase2_hydrate_schedule('idle', 'load')).toBe('load');
		expect(phase2_hydrate_schedule('load', 'visible')).toBe('visible');
	});
});

// Comment / element node shims (matching what region_ssr_truncated reads: nodeType, textContent, and
// childNodes for elements). Node types: 1 = element, 3 = text, 8 = comment.
const comment = (data: string) => ({ nodeType: 8, textContent: data });
const text = (data: string) => ({ nodeType: 3, textContent: data });
const elem = (...childNodes: unknown[]) => ({ nodeType: 1, childNodes });
const region = (...childNodes: unknown[]) => ({ childNodes }) as unknown as ParentNode;

describe('region_ssr_truncated (invalid-nesting hoist guard)', () => {
	// THE REPRO: a block island (`<div class="demo-counter">`) authored inline inside a markdown `<p>`.
	// The browser HTML parser closes the paragraph at the `<div>` start tag, popping <ogygia-region>
	// with it — so the region keeps ONLY its opening Svelte anchors while the rendered nodes are
	// hoisted out as siblings of the paragraph. Empirically the live region is `<!--[0--><!--[-->`.
	// Hydrating that empty region fresh-mounts a duplicate → two counters. Unbalanced ⇒ truncated.
	it('flags the parser-hoisted region (opening anchors, no closing) as truncated', () => {
		expect(region_ssr_truncated(region(comment('[0'), comment('[')))).toBe(true);
	});

	it('does NOT flag a validly-parsed inline island (balanced envelope, content intact)', () => {
		// The `<span>`-rendering fix: `<!--[0--><!--[--><span>…</span><!--]--><!--]-->` stays inside the
		// paragraph, anchors balanced. This is SSR count == hydrated count — one instance, no orphan.
		const span = elem(
			elem(text('−')), // <button>
			text(' '),
			elem(text('0')), // <output>
			text(' '),
			elem(text('+')) // <button>
		);
		expect(
			region_ssr_truncated(region(comment('[0'), comment('['), span, comment(']'), comment(']')))
		).toBe(false);
	});

	it('does NOT flag an island that renders nothing (balanced empty envelope)', () => {
		expect(
			region_ssr_truncated(region(comment('[0'), comment('['), comment(']'), comment(']')))
		).toBe(false);
	});

	it('does NOT flag a not-yet-swapped deferred/live region (no anchors at all)', () => {
		expect(region_ssr_truncated(region(text('loading…')))).toBe(false);
		expect(region_ssr_truncated(region())).toBe(false);
	});

	it('recurses: balanced anchors nested inside an element child are not a truncation', () => {
		const inner = elem(comment('['), elem(text('x')), comment(']'));
		expect(region_ssr_truncated(region(comment('['), inner, comment(']')))).toBe(false);
	});
});
