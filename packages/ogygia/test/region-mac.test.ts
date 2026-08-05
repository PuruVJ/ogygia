import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sign, verify, region_mac_message } from '../src/server/hmac.js';
import { html_has_kit_bootstrap } from '../src/runtime/kit-boot.js';
import { islandId } from '../src/vite/transform.js';

describe('region_mac_message', () => {
	const secret = 'test-secret-key';

	it('binds region id into the MAC', () => {
		const props = 'W3t9XQ';
		const exp = '1700000000';
		const a = sign(secret, region_mac_message('aaaaaa', exp, props));
		const b = sign(secret, region_mac_message('bbbbbb', exp, props));
		expect(a).not.toBe(b);
		expect(verify(secret, region_mac_message('aaaaaa', exp, props), a)).toBe(true);
		expect(verify(secret, region_mac_message('bbbbbb', exp, props), a)).toBe(false);
	});

	it('rejects expiry or props tampering', () => {
		const msg = region_mac_message('rid', '1700000000', 'propsblob');
		const sig = sign(secret, msg);
		expect(verify(secret, region_mac_message('rid', '1700000001', 'propsblob'), sig)).toBe(false);
		expect(verify(secret, region_mac_message('rid', '1700000000', 'other'), sig)).toBe(false);
	});
});

describe('islandId salt (P1-ID)', () => {
	it('matches unsalted legacy when salt is empty', () => {
		const legacy = createHash('md5').update('src/routes/+page.svelte::0').digest('hex').slice(0, 12);
		expect(islandId('src/routes/+page.svelte', 0)).toBe(legacy);
	});

	it('diverges when salt is set', () => {
		expect(islandId('src/routes/+page.svelte', 0, 'secret')).not.toBe(
			islandId('src/routes/+page.svelte', 0)
		);
	});
});

describe('kit bootstrap detection', () => {
	it('ignores __sveltekit_ reflected inside ogygia side-channels', () => {
		const html = `<html><body>
<script type="application/ogygia-page" data-ogygia-page>{"url":"http://x/?q=__sveltekit_x="}</script>
<script type="application/ogygia-props" data-ogygia-props>[]</script>
<script type="application/ogygia-remote">{"q":{}}</script>
</body></html>`;
		expect(html_has_kit_bootstrap(html)).toBe(false);
	});

	it('detects a real Kit assignment bootstrap', () => {
		const html = `<html><body>
<script>var __sveltekit_abc = { base: "/" };</script>
</body></html>`;
		expect(html_has_kit_bootstrap(html)).toBe(true);
	});

	it('strips type=application/ogygia-* even without data attrs', () => {
		// Defense in depth: MIME type alone identifies the side-channel.
		const html = `<html><body>
<script type="application/ogygia-page">{"url":"http://x/?q=__sveltekit_x="}</script>
</body></html>`;
		expect(html_has_kit_bootstrap(html)).toBe(false);
	});
});
