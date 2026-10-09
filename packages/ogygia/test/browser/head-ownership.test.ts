// WHO OWNS EACH NODE IN <head> (runtime/session.ts `RuntimeSession`): the page owns what the server
// sent and what the runtime inserts for it; an island owns what its `<svelte:head>` renders live; the
// page's copy of an island's content is retired, never the island's; a stylesheet link is never
// retired. End to end, with a real island and a real navigation: e2e/head-ownership.spec.ts.
import { beforeEach, expect, test } from 'vitest';
import { RuntimeSession } from '../../src/runtime/session.js';

const LD = '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>';
const SERVER_HEAD =
	'<meta charset="utf-8">' +
	'<title>Server title</title>' +
	LD +
	'<meta name="island" content="x">' +
	'<style>.hero{color:red}</style>' +
	'<link rel="preload" as="image" href="/hero.avif">' +
	'<link rel="stylesheet" href="/island.css">';

let s: RuntimeSession;
beforeEach(() => {
	s = new RuntimeSession();
	document.head.innerHTML = SERVER_HEAD;
	s.adopt_document_head();
});

/** What an island's fresh `<svelte:head>` render appends: the same content, live. */
function island_renders(html: string): Element[] {
	const before = new Set(document.head.childNodes);
	const tpl = document.createElement('template');
	tpl.innerHTML = html;
	const added = Array.from(tpl.content.children);
	document.head.append(...added);
	s.record_island_head(before);
	return added;
}

test('the island’s live copy stays, the page’s identical copies go', () => {
	const live = island_renders(
		LD +
			'<meta name="island" content="x"><style>.hero{color:red}</style><link rel="preload" as="image" href="/hero.avif">'
	);
	expect(document.head.querySelectorAll('script[type="application/ld+json"]').length).toBe(1);
	expect(document.head.querySelectorAll('meta[name="island"]').length).toBe(1);
	expect(document.head.querySelectorAll('style').length).toBe(1);
	expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(1);
	for (const el of live) expect(el.isConnected).toBe(true); // never the island's node
});

test('a stylesheet link is never retired (either copy leaving could unstyle a frame)', () => {
	island_renders('<link rel="stylesheet" href="/island.css">');
	expect(document.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(2);
});

test('the island’s title wins: the page’s title is retired, the island’s stays live', () => {
	const [title] = island_renders('<title>Island title</title>');
	expect(Array.from(document.head.querySelectorAll('title'))).toEqual([title]);
	expect(document.title).toBe('Island title');
});

test('content the island does not render is left alone', () => {
	island_renders('<meta name="other" content="y">');
	expect(document.head.innerHTML).toContain(LD);
	expect(document.head.querySelectorAll('title').length).toBe(1);
});

test('only PAGE-owned copies retire: a node nobody claimed (a third-party inject) stays', () => {
	const foreign = document.createElement('meta');
	foreign.name = 'island';
	foreign.content = 'x';
	document.head.prepend(foreign); // after boot adoption: not the page's
	island_renders('<meta name="island" content="x">');
	expect(foreign.isConnected).toBe(true);
});

test('a later pass (after a navigation merge) retires the new page’s copy of a kept island’s content', () => {
	island_renders(LD);
	// the router merged the next page's head, which carries the server copy again
	const tpl = document.createElement('template');
	tpl.innerHTML = LD;
	const copy = tpl.content.firstElementChild!;
	document.head.append(copy);
	s.claim_page_head(copy);
	s.retire_page_head_copies();
	expect(copy.isConnected).toBe(false);
	expect(document.head.querySelectorAll('script[type="application/ld+json"]').length).toBe(1);
});

test('an island torn down: its nodes are dropped from the watch list, the page keeps its copy', () => {
	const live = island_renders('<meta name="gone" content="z">');
	for (const el of live) el.remove(); // the island's own teardown
	const tpl = document.createElement('template');
	tpl.innerHTML = '<meta name="gone" content="z">';
	const copy = tpl.content.firstElementChild!;
	document.head.append(copy);
	s.claim_page_head(copy);
	s.retire_page_head_copies();
	expect(copy.isConnected).toBe(true);
	expect(s.island_head.size).toBe(0);
});
