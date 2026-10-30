// ogygia's base-less URLs (`/_app/immutable/…`) through Kit's `asset()`, which takes them without
// their leading slash (and warns on one with it).
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
	it('hands Kit the path without its leading slash — never the slash it warns about', async () => {
		const seen: string[] = [];
		const kit_asset = await with_kit((f) => (seen.push(f), './' + f));
		expect(kit_asset('/_app/immutable/x.js')).toBe('./_app/immutable/x.js');
		expect(kit_asset('/@id/virtual:ogygia/island/a.js')).toBe('./@id/virtual:ogygia/island/a.js');
		expect(seen).toEqual(['_app/immutable/x.js', '@id/virtual:ogygia/island/a.js']);
	});

	it('a path already without the slash passes as it is', async () => {
		const kit_asset = await with_kit((f) => '/base/' + f);
		expect(kit_asset('_app/immutable/x.js')).toBe('/base/_app/immutable/x.js');
	});
});
