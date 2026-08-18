import { describe, it, expect } from 'vitest';
import {
	page_declares_router_meta,
	page_declares_runtime_script,
	page_declares_dev_hmr_script,
	page_declares_speculation_rules
} from '../src/server/head-presence.js';

// ─────────────────────────────────────────────────────────────────────────────
// The `handle()` transform skips injecting a head tag the page already carries. These predicates
// decide "already carries", and MUST NOT be fooled by a page that documents the tag in prose.
//
// Regression: the changelog page has `` `<meta name="ogygia-router" content="plain">` `` in its body,
// which renders escaped (`&lt;meta name="ogygia-router" …`). A substring check false-matched it, so
// the real marker was never injected and the page silently dropped to full-page navigation (no SPA,
// no view transition), TO and FROM it.
// ─────────────────────────────────────────────────────────────────────────────

// How markdown renders an inline `` `<meta …>` `` code span: `<` escaped to `&lt;`, `>` left literal.
const escaped_meta =
	'<p>opt out with <code>&lt;meta name="ogygia-router" content="plain"></code> in its head.</p>';
const escaped_runtime = '<p>island pages carry <code>data-ogygia-runtime</code>.</p>';

describe('page_declares_router_meta', () => {
	it('is FALSE for an escaped code-block mention (the changelog case)', () => {
		expect(page_declares_router_meta(escaped_meta)).toBe(false);
	});

	it('is FALSE when a fenced block splits the tag across highlighter spans', () => {
		// Shiki-style: the `<` is still escaped, so no literal `<meta` survives.
		const shiki = '<pre><code><span>&lt;</span><span>meta name="ogygia-router"</span></code></pre>';
		expect(page_declares_router_meta(shiki)).toBe(false);
	});

	it('is TRUE for a real author-authored element (page wins — feature preserved)', () => {
		expect(page_declares_router_meta('<head><meta name="ogygia-router" content="plain"></head>')).toBe(true);
	});

	it('is TRUE regardless of attribute order or quote style', () => {
		expect(page_declares_router_meta('<meta content="plain" name="ogygia-router">')).toBe(true);
		expect(page_declares_router_meta("<meta name='ogygia-router' content='vt'>")).toBe(true);
		expect(page_declares_router_meta('<meta\n  name="ogygia-router"\n  content="vt">')).toBe(true);
	});

	it('is FALSE with no mention at all', () => {
		expect(page_declares_router_meta('<head><title>x</title></head>')).toBe(false);
	});
});

describe('page_declares_runtime_script', () => {
	it('is FALSE for an escaped/code mention', () => {
		expect(page_declares_runtime_script(escaped_runtime)).toBe(false);
	});

	it('is FALSE when only the SCRIPT BODY (inline JS) references the attribute', () => {
		expect(
			page_declares_runtime_script('<script>document.querySelector("[data-ogygia-runtime]")</script>')
		).toBe(false);
	});

	it('is TRUE for the real bootstrap tag Region emits', () => {
		expect(
			page_declares_runtime_script('<script type="module" data-ogygia-runtime src="/x.js"></script>')
		).toBe(true);
	});
});

describe('page_declares_dev_hmr_script', () => {
	it('distinguishes a real tag from a code mention', () => {
		expect(page_declares_dev_hmr_script('<code>data-ogygia-dev-hmr</code>')).toBe(false);
		expect(page_declares_dev_hmr_script('<script type="module" data-ogygia-dev-hmr src="/h.js"></script>')).toBe(true);
	});
});

describe('page_declares_speculation_rules', () => {
	it('distinguishes a real tag from a code mention', () => {
		expect(page_declares_speculation_rules('<code>type="speculationrules"</code>')).toBe(false);
		expect(page_declares_speculation_rules('<script type="speculationrules">{}</script>')).toBe(true);
	});
});
