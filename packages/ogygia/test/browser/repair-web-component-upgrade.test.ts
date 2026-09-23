// A top-level island's connect-time snapshot is pristine (measured: og-runtime defines before the
// design-system runtime). Yet the island still discards when a custom element inside it upgrades before
// wake: it gains a shadow root and its light DOM is reshaped. So the failure is in REPAIR, not capture.
// Two candidate drift shapes, run straight through repair_if_drifted (a plain <div> stands in for the
// region; the pristine copy is the server bytes). After repair, the live sequence must equal the server's
// — that is exactly what Svelte's walk needs — or the island discards.
import { expect, test, afterEach } from 'vitest';
import { repair_if_drifted, sequence_differs } from '../../src/runtime/hydrate-core.js';
import { parse_region_html } from '../../src/runtime/parse-html.js';
import { install as install_morph } from '../../src/runtime/morph.js';
// The REAL repair path: with the morph installed, align_to falls to the morph on a skeleton mismatch
// (not the innerHTML swap it uses when no morph feature shipped).
install_morph();

afterEach(() => { document.body.innerHTML = ''; });

/** Live region built from `pristine`, then `mutate` simulates the web-component upgrade. */
function region_from(pristine: string, mutate: (region: HTMLElement) => void): HTMLElement {
	const region = document.createElement('div');
	region.innerHTML = pristine;
	document.body.appendChild(region);
	mutate(region);
	return region;
}
/** `want` exactly as repair builds it: the server bytes through the one DSD-aware parser. */
function want_of(pristine: string): Element {
	const frag = parse_region_html(pristine);
	const w = frag.ownerDocument.createElement('ogygia-region');
	w.appendChild(frag);
	return w;
}
const drop_ws = (root: ParentNode) => {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const doomed: Node[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.textContent?.trim()) doomed.push(n);
	doomed.forEach((n) => n.remove());
};

test('(a) shadow root gained + whitespace collapsed, element skeleton intact → repaired to the server sequence', () => {
	const pristine = ' <x-wrap><span>a</span> <b>b</b></x-wrap> <p>after</p>';
	const region = region_from(pristine, (r) => {
		r.querySelector('x-wrap')!.attachShadow({ mode: 'open' });
		drop_ws(r);
	});
	expect(sequence_differs(region, want_of(pristine))).toBe(true); // drift is real
	const out = repair_if_drifted(region, pristine);
	expect(out.repaired).toBe(true);
	expect(sequence_differs(region, want_of(pristine))).toBe(false); // Svelte's walk would match
});

test('(b) a NESTED upgraded custom element also had a child added by the runtime → repaired to pristine', () => {
	// The wrapper upgrades AND a custom element inside it upgrades, and that inner runtime appends its
	// own light child (a slot fallback / a wrapper node). Its element skeleton now differs from the
	// server's, so align_to falls to the morph for that subtree.
	const pristine = '<x-wrap><x-btn><span>go</span></x-btn> <p>after</p></x-wrap>';
	const region = region_from(pristine, (r) => {
		r.querySelector('x-wrap')!.attachShadow({ mode: 'open' });
		const btn = r.querySelector('x-btn')!;
		btn.attachShadow({ mode: 'open' });
		btn.appendChild(Object.assign(document.createElement('i'), { textContent: 'rt' }));
		drop_ws(r);
	});
	expect(sequence_differs(region, want_of(pristine))).toBe(true);
	const out = repair_if_drifted(region, pristine);
	expect(out.repaired).toBe(true);
	// The runtime-added <i> must be GONE: repair restores the server DOM so hydration can claim it.
	expect(region.querySelector('x-btn i')).toBeNull();
	expect(sequence_differs(region, want_of(pristine))).toBe(false);
});

test('(c) residue INSIDE a nested upgraded element, with the outer skeleton also changed → must still repair to pristine', () => {
	// The LoginDropdown shape: the outer host's element skeleton differs (its runtime added a sibling),
	// so align_to falls to the morph with the OUTER as entry — and a nested upgraded element inside it
	// also had a light child appended by ITS runtime. If the morph treats that nested host's children
	// as "its own" (keep, never remove), the added node survives repair, and Svelte's walk lands on it:
	// `set_custom_element_data(e)` → `e.getAttribute is not a function`, then hydration_failed.
	const pristine = '<x-wrap><x-btn><span>go</span></x-btn> <p>after</p></x-wrap>';
	const region = region_from(pristine, (r) => {
		const wrap = r.querySelector('x-wrap')!;
		wrap.attachShadow({ mode: 'open' });
		wrap.appendChild(Object.assign(document.createElement('div'), { textContent: 'rt-outer' })); // skeleton differs
		const btn = r.querySelector('x-btn')!;
		btn.attachShadow({ mode: 'open' });
		btn.appendChild(Object.assign(document.createElement('i'), { textContent: 'rt' })); // nested residue
		drop_ws(r);
	});
	expect(sequence_differs(region, want_of(pristine))).toBe(true);
	const out = repair_if_drifted(region, pristine);
	expect(out.repaired).toBe(true);
	expect(region.querySelector('x-btn i')).toBeNull(); // the residue Svelte would trip on
	expect(sequence_differs(region, want_of(pristine))).toBe(false);
});
