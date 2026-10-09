// ogygia's base-less URLs (`/_app/immutable/…`) through Kit's `asset()` on Kit 2 and Kit 3 without
// reading a version: Kit 2 throws on a path without its leading slash, Kit 3 warns on one with it.
// The first call tries it without; a Kit that refuses gets the slash from then on.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.resetModules();
	vi.doUnmock('$app/paths');
});

async function with_kit(asset: (f: string) => string) {
	vi.doMock('$app/paths', () => ({ asset }));
	return (await import('../src/kit-paths.js')).kit_asset;
}

describe('kit_asset', () => {
	it("Kit 3's form (no slash) where Kit takes it: never the slash it warns about", async () => {
		const seen: string[] = [];
		const kit_asset = await with_kit((f) => {
			seen.push(f);
			if (f.startsWith('/')) throw new Error('a Kit 3 dev warning would print here');
			return '/base/' + f;
		});
		expect(kit_asset('/_app/immutable/x.js')).toBe('/base/_app/immutable/x.js');
		expect(kit_asset('/@id/virtual:ogygia/island/a.js')).toBe('/base/@id/virtual:ogygia/island/a.js');
		expect(seen.every((f) => !f.startsWith('/'))).toBe(true);
	});

	it("Kit 2's form (the slash) where Kit refuses the other: tried once, then the slash every time", async () => {
		const seen: string[] = [];
		const kit_asset = await with_kit((f) => {
			seen.push(f);
			if (!f.startsWith('/')) throw new Error('Cannot use `resolve(...)` with a non-absolute pathname');
			return '/base' + f;
		});
		expect(kit_asset('/_app/immutable/x.js')).toBe('/base/_app/immutable/x.js');
		expect(kit_asset('/_app/immutable/y.js')).toBe('/base/_app/immutable/y.js');
		// one refused try, then straight to the slash
		expect(seen).toEqual(['_app/immutable/x.js', '/_app/immutable/x.js', '/_app/immutable/y.js']);
	});

	it("Kit 2 in a BUILD (no refusal: it returns the slash-less path page-relative) — still the slash", async () => {
		// REGRESSION (field report on 5c0e2c45): `asset('_uce_/immutable/x.js')` answered
		// `_uce_/immutable/x.js` in production, which a page at /account/ resolved to /account/_uce_/…
		const kit_asset = await with_kit((f) => '' + f);
		expect(kit_asset('/_uce_/immutable/x.js')).toBe('/_uce_/immutable/x.js');
		expect(kit_asset('/_uce_/immutable/y.js')).toBe('/_uce_/immutable/y.js');
	});

	it('the build’s Kit major decides with no probe at all', async () => {
		vi.stubGlobal('__OGYGIA_KIT_MAJOR__', 2);
		const seen: string[] = [];
		const kit2 = await with_kit((f) => (seen.push(f), '' + f));
		expect(kit2('/_app/immutable/x.js')).toBe('/_app/immutable/x.js');
		expect(seen).toEqual(['/_app/immutable/x.js']);
		vi.resetModules();
		vi.stubGlobal('__OGYGIA_KIT_MAJOR__', 3);
		const kit3 = await with_kit((f) => './' + f);
		expect(kit3('/_app/immutable/x.js')).toBe('./_app/immutable/x.js');
		vi.unstubAllGlobals();
	});

	it('a value without a leading slash passes through as it is', async () => {
		const kit_asset = await with_kit((f) => 'kit:' + f);
		expect(kit_asset('already/relative.js')).toBe('kit:already/relative.js');
	});
});
