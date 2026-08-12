// Region parcels for the batch endpoint (route weaving / navigation OOO) — the PURE parcel layer.
// The `handle()` batch endpoint uses these to box each rendered region call as a slot-keyed
// `<template>`; the client frame stream (`frame-nav.ts`) reads them. DOM delivery is covered by the
// browser suites `verify/frame-batch.ts` / `verify/frame-ooo.ts`. Runs against `../dist`.

import { describe, test, expect } from 'vitest';
import { build_parcel, done_parcel } from '../dist/server/stream-regions.js';

describe('build_parcel / done_parcel', () => {
	test('wraps rendered HTML in a slot-keyed template', () => {
		expect(build_parcel('SIG', '<p>hi</p>')).toBe(
			'<template data-ogygia-slot="SIG"><p>hi</p></template>'
		);
	});
	test('refuses HTML that would break out of the template box (falls back to fetch)', () => {
		expect(build_parcel('SIG', 'x</template><script>bad()</script>')).toBeNull();
	});
	test('done sentinel uses the reserved slot', () => {
		expect(done_parcel()).toBe('<template data-ogygia-slot="__ogygia_done__"></template>');
	});
});
