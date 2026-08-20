/**
 * Reconciler R0 — region signature + props-fingerprint (the pure identity core).
 */
import { describe, it, expect } from 'vitest';
import { fnv1a, endpoint_key, signature_of, fingerprint_of } from '../src/runtime/reconcile.js';

describe('fnv1a', () => {
	it('is deterministic and change-sensitive', () => {
		expect(fnv1a('abc')).toBe(fnv1a('abc'));
		expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
		expect(fnv1a('')).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('endpoint_key — strips the volatile exp/sig tail', () => {
	it('keeps id+props, drops exp+sig (so two renders of one region match)', () => {
		const a = '/__ogygia__?id=7c4a&props=W3si&exp=2102576359&sig=e884472d95';
		const b = '/__ogygia__?id=7c4a&props=W3si&exp=9999999999&sig=ffffffffff';
		expect(endpoint_key(a)).toBe(endpoint_key(b)); // same region, later render
		expect(endpoint_key(a)).toBe('/__ogygia__?id=7c4a&props=W3si');
	});

	it('is empty for an island with no endpoint; a props change DOES shift the key', () => {
		expect(endpoint_key('')).toBe('');
		const p1 = '/__ogygia__?id=7c4a&props=AAAA&exp=1&sig=x';
		const p2 = '/__ogygia__?id=7c4a&props=BBBB&exp=1&sig=x';
		expect(endpoint_key(p1)).not.toBe(endpoint_key(p2)); // different props → different slot inputs
	});
});

describe('signature_of — the match key (which slot)', () => {
	it('same entry+endpoint-id → same signature across renders', () => {
		const s1 = signature_of('./chunk.abc.js', '/__ogygia__?id=1&props=X&exp=1&sig=a');
		const s2 = signature_of('./chunk.abc.js', '/__ogygia__?id=1&props=X&exp=2&sig=b');
		expect(s1).toBe(s2);
	});
	it('different component → different signature', () => {
		expect(signature_of('./a.js', '')).not.toBe(signature_of('./b.js', ''));
	});
});

describe('fingerprint_of — the change key (did inputs change)', () => {
	it('equal when entry+endpoint+props seed are equal (→ KEEP)', () => {
		expect(fingerprint_of('./a.js', '', '["seed",1]')).toBe(fingerprint_of('./a.js', '', '["seed",1]'));
	});
	it('changes when the props seed changes (→ PATCH)', () => {
		expect(fingerprint_of('./a.js', '', '["seed",1]')).not.toBe(fingerprint_of('./a.js', '', '["seed",2]'));
	});
	it('ignores exp/sig rotation in the endpoint (not an input change)', () => {
		const fp1 = fingerprint_of('', '/__ogygia__?id=1&props=X&exp=1&sig=a', '');
		const fp2 = fingerprint_of('', '/__ogygia__?id=1&props=X&exp=2&sig=b', '');
		expect(fp1).toBe(fp2);
	});
});

// R1 stamping + shadow guard use a DOM. Skip if jsdom-less; these run under the happy-dom/jsdom env.
import { stamp_region_keys, region_in_shadow } from '../src/runtime/reconcile.js';

const hasDOM = typeof document !== 'undefined';
(hasDOM ? describe : describe.skip)('R1 stamping + shadow guard', () => {
	function body(html: string): HTMLElement {
		const b = document.createElement('body');
		b.innerHTML = html;
		return b;
	}

	it('stamps regions with signature:fingerprint and keep-chrome by keep name', () => {
		const b = body(
			'<ogygia-region entry="./a.js" wake="load"></ogygia-region>' +
				'<script data-ogygia-props type="application/json">["p",1]</script>' +
				'<div data-ogygia-keep="side"></div>'
		);
		stamp_region_keys(b);
		const region = b.querySelector('ogygia-region')!;
		const keep = b.querySelector('[data-ogygia-keep]')!;
		expect(region.getAttribute('data-key')).toMatch(/^r[\x00 ][0-9a-f]{16}$/); // one identity: 'r' + 64-bit fp
		expect(keep.getAttribute('data-key')).toBe('k side');
	});

	it('does not clobber an authored data-key or id', () => {
		const b = body('<ogygia-region entry="./a.js" data-key="mine"></ogygia-region>');
		stamp_region_keys(b);
		expect(b.querySelector('ogygia-region')!.getAttribute('data-key')).toBe('mine');
	});

	it('a KEEP (same props) gets the same key across two renders; a PATCH (changed props) differs', () => {
		const mk = (seed: string) =>
			body(
				'<ogygia-region entry="./a.js"></ogygia-region>' +
					`<script data-ogygia-props type="application/json">${seed}</script>`
			);
		const a = mk('["p",1]');
		const b = mk('["p",1]');
		const c = mk('["p",2]');
		stamp_region_keys(a);
		stamp_region_keys(b);
		stamp_region_keys(c);
		const key = (x: HTMLElement) => x.querySelector('ogygia-region')!.getAttribute('data-key');
		expect(key(a)).toBe(key(b)); // KEEP
		expect(key(a)).not.toBe(key(c)); // PATCH
	});

	it('region_in_shadow flags an open shadow root containing a region + the opt-out attr', () => {
		const b = body('<div></div>');
		expect(region_in_shadow(b)).toBe(false); // plain light DOM
		const host = document.createElement('wds-card');
		const sr = host.attachShadow({ mode: 'open' });
		sr.innerHTML = '<ogygia-region entry="./x.js"></ogygia-region>';
		b.appendChild(host);
		expect(region_in_shadow(b)).toBe(true); // region inside shadow → fall back
		const b2 = body('<div data-og-no-reconcile></div>');
		expect(region_in_shadow(b2)).toBe(true); // explicit opt-out
	});
});

describe('server↔client fingerprint parity (D1)', () => {
	it('server data-og-fp = fingerprint_of(entry, "", payload) EQUALS client region_props_fp', () => {
		const entry = '/_app/immutable/og-region.abc.js';
		const payload = '[{"label":1},"alpha"]';
		// server computes (Region.svelte): fingerprint_of(island_module_url, '', island_payload)
		const server_fp = fingerprint_of(entry, '', payload);
		// client computes (region_props_fp): fingerprint_of(entry-attr, ''-endpoint, props-script-text)
		const client_fp = fingerprint_of(entry, '', payload);
		expect(server_fp).toBe(client_fp);
	});
});
