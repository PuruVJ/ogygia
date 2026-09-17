import { describe, it, expect } from 'vitest';
import {
	page_declares_router_meta,
	page_declares_runtime_script,
	page_declares_dev_hmr_script,
	page_declares_speculation_rules,
	runtime_first
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
		expect(
			page_declares_router_meta('<head><meta name="ogygia-router" content="plain"></head>')
		).toBe(true);
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
			page_declares_runtime_script(
				'<script>document.querySelector("[data-ogygia-runtime]")</script>'
			)
		).toBe(false);
	});

	it('is TRUE for the real bootstrap tag Region emits', () => {
		expect(
			page_declares_runtime_script(
				'<script type="module" data-ogygia-runtime src="/x.js"></script>'
			)
		).toBe(true);
	});
});

describe('page_declares_dev_hmr_script', () => {
	it('distinguishes a real tag from a code mention', () => {
		expect(page_declares_dev_hmr_script('<code>data-ogygia-dev-hmr</code>')).toBe(false);
		expect(
			page_declares_dev_hmr_script(
				'<script type="module" data-ogygia-dev-hmr src="/h.js"></script>'
			)
		).toBe(true);
	});
});

describe('page_declares_speculation_rules', () => {
	it('distinguishes a real tag from a code mention', () => {
		expect(page_declares_speculation_rules('<code>type="speculationrules"</code>')).toBe(false);
		expect(page_declares_speculation_rules('<script type="speculationrules">{}</script>')).toBe(
			true
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The runtime bootstrap is the FIRST script in `<head>`. Module scripts run in document order
// once parsing ends; a design-system runtime an app template loads ahead of Kit's head slot ran
// before the ogygia runtime on a customer page and edited every sleeping island before the runtime
// kept their server markup — so the "server copy" was the edited DOM and no island could heal.
// ─────────────────────────────────────────────────────────────────────────────
const runtime = '<script type="module" data-ogygia-runtime src="/_app/og-runtime.js"></script>';
const design_system = '<script type="module" src="https://cdn.example/ds.js"></script>';
const head_start =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="w">';

describe('runtime_first', () => {
	it('moves the tag an island page emitted ahead of the app template scripts, after the charset', () => {
		const head =
			head_start +
			design_system +
			'<title>x</title>' +
			runtime +
			'<link rel="stylesheet" href="/a.css">';
		expect(runtime_first(head, null)).toBe(
			'<!doctype html><html><head><meta charset="utf-8">' +
				runtime +
				'<meta name="viewport" content="w">' +
				design_system +
				'<title>x</title>' +
				'<link rel="stylesheet" href="/a.css">'
		);
	});

	it('injects the tag there when the page has none (island-less page, router on)', () => {
		expect(runtime_first(head_start + design_system, runtime)).toBe(
			'<!doctype html><html><head><meta charset="utf-8">' +
				runtime +
				'<meta name="viewport" content="w">' +
				design_system
		);
	});

	it('leads the head when no charset declaration opens it', () => {
		expect(runtime_first('<html><head>' + design_system + runtime, null)).toBe(
			'<html><head>' + runtime + design_system
		);
	});

	it('leads inner head content that has no <head> tag (a routeless document)', () => {
		expect(runtime_first('<title>t</title>' + design_system + runtime, null)).toBe(
			runtime + '<title>t</title>' + design_system
		);
	});

	it('returns the same string when the tag is already first, or there is nothing to place', () => {
		const already = '<html><head><meta charset="utf-8">' + runtime + design_system;
		expect(runtime_first(already, null)).toBe(already);
		expect(runtime_first(already, runtime)).toBe(already);
		const none = '<html><head>' + design_system;
		expect(runtime_first(none, null)).toBe(none);
	});

	it('does not mistake a prose mention or an inline script body for the tag', () => {
		const prose =
			'<html><head>' +
			design_system +
			escaped_runtime +
			'<script>document.querySelector("[data-ogygia-runtime]")</script>';
		expect(runtime_first(prose, null)).toBe(prose);
		expect(runtime_first(prose, runtime)).toBe(
			'<html><head>' +
				runtime +
				design_system +
				escaped_runtime +
				'<script>document.querySelector("[data-ogygia-runtime]")</script>'
		);
	});
});
