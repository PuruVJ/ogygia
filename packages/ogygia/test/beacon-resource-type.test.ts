import { describe, expect, it } from 'vitest';
import { resource_type } from '../src/runtime/beacon.js';

describe('resource_type: what a file counts as', () => {
	it('a link is not a stylesheet by itself', () => {
		// a modulepreload (Chromium says `other`; a link initiator must not turn it into CSS either)
		expect(resource_type('js', 'link', 'script')).toBe('script');
		expect(resource_type('', 'link', 'script')).toBe('script');
		// a hole's preload (`as="fetch"`, no extension): its HTML answer
		expect(resource_type('', 'link', 'fetch')).toBe('fetch');
		expect(resource_type('woff2', 'link', 'font')).toBe('font');
		expect(resource_type('', 'link', 'image')).toBe('img');
		expect(resource_type('', 'link', 'document')).toBe('other');
		// a stylesheet link without an extension (a font service's css2?family=…)
		expect(resource_type('', 'link')).toBe('css');
		expect(resource_type('css', 'link', 'style')).toBe('css');
	});

	it('the extension first, then what started it', () => {
		expect(resource_type('png', 'css')).toBe('img');
		expect(resource_type('woff2', 'css')).toBe('font');
		expect(resource_type('', 'css')).toBe('css');
		expect(resource_type('', 'script')).toBe('script');
		expect(resource_type('css', 'script')).toBe('css');
		expect(resource_type('', 'fetch')).toBe('fetch');
		expect(resource_type('', 'xmlhttprequest')).toBe('fetch');
		expect(resource_type('', 'other')).toBe('other');
	});
});
