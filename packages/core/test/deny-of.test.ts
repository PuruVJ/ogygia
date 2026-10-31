// A REFUSED HOLE NAMES WHO REFUSED IT (runtime/region-endpoint-url.ts `deny_of`): ogygia's 403
// carries `x-ogygia-deny`; a 403 without it came from something in front of the handle (a bot
// wall at the CDN), and must not read as ogygia's refusal — or the field chases ogygia for it.
import { describe, it, expect, beforeAll } from 'vitest';
import { deny_of, NOT_OGYGIA_403 } from '../src/runtime/region-endpoint-url.ts';

beforeAll(() => {
	(globalThis as { location?: unknown }).location ??= { href: 'https://a.test/page' };
});

const res403 = (headers: Record<string, string>) =>
	new Response('Forbidden', { status: 403, headers });
const endpoint = '/__ogygia__?id=abc123abc123&props=e30&exp=1&sig=s&k=aaaa1111';

describe('deny_of', () => {
	it('a 403 without x-ogygia-deny is not ogygia: a proxy, CDN or firewall answered', () => {
		expect(deny_of(res403({}), endpoint)).toBe(NOT_OGYGIA_403);
	});

	it("ogygia's reason, as sent", () => {
		expect(deny_of(res403({ 'x-ogygia-deny': 'sig', 'x-ogygia-key': 'aaaa1111' }), endpoint)).toBe(
			'sig'
		);
		expect(deny_of(res403({ 'x-ogygia-deny': 'unknown-id' }), endpoint)).toBe('unknown-id');
	});

	it('foreign-key names both keys: the one that signed, the one that answered', () => {
		expect(
			deny_of(res403({ 'x-ogygia-deny': 'foreign-key', 'x-ogygia-key': 'bbbb2222' }), endpoint)
		).toBe('foreign-key: signed by aaaa1111, answered by bbbb2222');
	});
});
