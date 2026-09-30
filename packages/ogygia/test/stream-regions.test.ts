// Region parcels for the batch endpoint (single-flight navigation / navigation OOO) — the PURE parcel layer.
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
	test('length-frames HTML that carries its own </template (it can never close the box)', () => {
		const html = 'x</TEMPLATE><script>bad()</script>';
		expect(build_parcel('SIG', html)).toBe(
			`<template data-ogygia-slot="SIG" data-og-len="${html.length}">${html}</template>`
		);
	});
	test('done sentinel uses the reserved slot', () => {
		expect(done_parcel()).toBe('<template data-ogygia-slot="__ogygia_done__"></template>');
	});
});
