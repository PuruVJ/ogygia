// PAGE-CSR invariant (internal/notes/INVARIANTS.md): a page's effective csr is Kit's own
// computation — the option-file chain root → page dir, deepest declaration wins — and a LAYOUT
// has no world of its own: it derives from the pages it serves (all true → strip, all false →
// island world, mixed → shared world). The regression this guards: `csr = false` declared only
// in a deep catch-all made the ROOT layout read as csr=true, stripping its Header/BootEffects
// islands while Kit shipped no client for those pages — dead chrome (hit at a consumer).
//
// This suite is deliberately a MATRIX — csr-topology bugs keep recurring, so every declaration
// position, chain shape, and layout fold is pinned here, plus the transform-level strip/keep
// seam. The browser truth lives in e2e/deep-csr.ts (a real build of internal/repro-deep-csr).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	routeCsrIsFalse,
	routeCsrIsTrue,
	csrTrueRouteIds,
	hasAnyCsrTrueRoute,
	read_csr,
	clear_route_csr_cache
} from '../src/compiler/kit.js';
import { transformHost } from '../src/compiler/region/transform.js';

/** Write a route tree: { 'content/[...slug]/+page.ts': 'export const csr = false;' }. */
function tree(files: Record<string, string>): string {
	const routes = path.join(mkdtempSync(path.join(tmpdir(), 'og-csr-')), 'routes');
	for (const [rel, src] of Object.entries(files)) {
		const abs = path.join(routes, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, src);
	}
	return routes;
}
const at = (routes: string, rel: string) => path.join(routes, rel);
/** world(host) → 'strip' | 'island' | 'shared' — the tri-state the driver derives. */
function world(routes: string, rel: string): 'strip' | 'island' | 'shared' {
	const host = at(routes, rel);
	return routeCsrIsTrue(host, routes)
		? 'strip'
		: routeCsrIsFalse(host, routes)
			? 'island'
			: 'shared';
}

beforeEach(() => clear_route_csr_cache());

// ── read_csr — the single declaration reader ─────────────────────────────────────────────────

describe('read_csr — declaration forms', () => {
	const one = (src: string) => {
		const routes = tree({ '+page.ts': src });
		return read_csr(at(routes, '+page.ts'));
	};
	it('plain false / true / absent', () => {
		expect(one('export const csr = false;\n')).toBe(false);
		expect(one('export const csr = true;\n')).toBe(true);
		expect(one('export const prerender = true;\n')).toBe(undefined);
	});
	it('typed form `csr: boolean`', () => {
		expect(one('export const csr: boolean = false;\n')).toBe(false);
	});
	it('commented-out declarations never win', () => {
		expect(one('// export const csr = true\nexport const csr = false;\n')).toBe(false);
		expect(one('/* export const csr = true */\nexport const csr = false;\n')).toBe(false);
		expect(one('// export const csr = false\n')).toBe(undefined);
	});
});

// ── per-PAGE effective csr — Kit's own-chain rule ────────────────────────────────────────────

describe('page world — option-file chain, deepest wins', () => {
	it.each([
		['+layout.ts', 'layout .ts'],
		['+layout.js', 'layout .js'],
		['+layout.server.ts', 'layout .server.ts'],
		['+page.ts', 'page .ts'],
		['+page.server.ts', 'page .server.ts'],
		['+page.js', 'page .js']
	])('csr=false in root-level %s reaches the page', (file) => {
		const routes = tree({
			[file]: 'export const csr = false;\n',
			'+page.svelte': '<h1>p</h1>'
		});
		expect(routeCsrIsFalse(at(routes, '+page.svelte'), routes)).toBe(true);
	});

	it('deepest declaration wins across a false → true → false chain', () => {
		const routes = tree({
			'+layout.ts': 'export const csr = false;\n',
			'a/+layout.ts': 'export const csr = true;\n',
			'a/b/+layout.ts': 'export const csr = false;\n',
			'a/b/+page.svelte': '<h1>b</h1>',
			'a/+page.svelte': '<h1>a</h1>',
			'+page.svelte': '<h1>root</h1>'
		});
		expect(routeCsrIsFalse(at(routes, 'a/b/+page.svelte'), routes)).toBe(true);
		expect(routeCsrIsFalse(at(routes, 'a/+page.svelte'), routes)).toBe(false);
		expect(routeCsrIsFalse(at(routes, '+page.svelte'), routes)).toBe(true);
	});

	it("the page's own option file beats every layout above it", () => {
		const routes = tree({
			'+layout.ts': 'export const csr = false;\n',
			'admin/+page.ts': 'export const csr = true;\n',
			'admin/+page.svelte': '<h1>admin</h1>'
		});
		expect(routeCsrIsTrue(at(routes, 'admin/+page.svelte'), routes)).toBe(true);
	});

	it('group-segment option files participate in the chain', () => {
		const routes = tree({
			'(app)/+layout.ts': 'export const csr = false;\n',
			'(app)/dash/+page.svelte': '<h1>d</h1>'
		});
		expect(routeCsrIsFalse(at(routes, '(app)/dash/+page.svelte'), routes)).toBe(true);
	});

	it('rest/optional param dirs are ordinary chain segments', () => {
		const routes = tree({
			'docs/[[lang]]/[...slug]/+page.ts': 'export const csr = false;\n',
			'docs/[[lang]]/[...slug]/+page.svelte': '<h1>doc</h1>'
		});
		expect(routeCsrIsFalse(at(routes, 'docs/[[lang]]/[...slug]/+page.svelte'), routes)).toBe(true);
	});

	it('non-route files and files outside routesDir are never route hosts', () => {
		const routes = tree({ '+page.svelte': '<h1>p</h1>' });
		expect(routeCsrIsFalse(at(routes, 'Widget.svelte'), routes)).toBe(false);
		expect(routeCsrIsTrue(at(routes, 'Widget.svelte'), routes)).toBe(false);
		expect(routeCsrIsFalse('/elsewhere/+page.svelte', routes)).toBe(false);
	});
});

// ── LAYOUT world — the fold over the pages it serves ─────────────────────────────────────────

describe('layout world — derived from pages, never its own chain', () => {
	it('THE REGRESSION: csr=false only in a deep catch-all still islands the root layout', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'content/[...slug]/+page.ts': 'export const csr = false;\n',
			'content/[...slug]/+page.svelte': '<h1>c</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('island');
		expect(csrTrueRouteIds(routes)).toEqual([]);
		expect(hasAnyCsrTrueRoute(routes)).toBe(false);
	});

	it('mixed subtree → shared world; runtime set carries exactly the true pages', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'content/[...slug]/+page.ts': 'export const csr = false;\n',
			'content/[...slug]/+page.svelte': '<h1>c</h1>',
			'spa/+page.svelte': '<h1>spa</h1>' // no options → Kit default true
		});
		expect(world(routes, '+layout.svelte')).toBe('shared');
		expect(csrTrueRouteIds(routes)).toEqual(['/spa']);
		expect(hasAnyCsrTrueRoute(routes)).toBe(true);
	});

	it('root csr=false with a deeper csr=true override — layout goes shared', () => {
		const routes = tree({
			'+layout.ts': 'export const csr = false;\n',
			'+layout.svelte': '<slot />',
			'+page.svelte': '<h1>home</h1>',
			'admin/+page.ts': 'export const csr = true;\n',
			'admin/+page.svelte': '<h1>admin</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('shared');
		expect(csrTrueRouteIds(routes)).toEqual(['/admin']);
	});

	it('all pages Kit-hydrated → the layout strips', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'+page.svelte': '<h1>home</h1>',
			'about/+page.svelte': '<h1>about</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('strip');
	});

	it('every page below csr=false (declared at various depths) → island world', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'+layout.ts': 'export const csr = false;\n',
			'+page.svelte': '<h1>home</h1>',
			'blog/[slug]/+page.svelte': '<h1>post</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('island');
	});

	it('NESTED layouts are each judged by their OWN subtree', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'spa/+page.svelte': '<h1>spa</h1>',
			'content/+layout.svelte': '<slot />',
			'content/+layout.ts': 'export const csr = false;\n',
			'content/a/+page.svelte': '<h1>a</h1>',
			'content/b/+page.svelte': '<h1>b</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('shared'); // serves spa (true) + content (false)
		expect(world(routes, 'content/+layout.svelte')).toBe('island'); // its own subtree is pure false
	});

	it('a nested layout whose subtree is pure csr=true strips even under a csr=false root', () => {
		const routes = tree({
			'+layout.ts': 'export const csr = false;\n',
			'+layout.svelte': '<slot />',
			'+page.svelte': '<h1>home</h1>',
			'admin/+layout.svelte': '<slot />',
			'admin/+layout.ts': 'export const csr = true;\n',
			'admin/+page.svelte': '<h1>admin</h1>'
		});
		expect(world(routes, 'admin/+layout.svelte')).toBe('strip');
		expect(world(routes, '+layout.svelte')).toBe('shared');
	});

	it('a layout with no pages below falls back to its own chain', () => {
		const routes = tree({
			'+page.svelte': '<h1>home</h1>',
			'api/+layout.svelte': '<slot />',
			'api/+server.ts': 'export const GET = () => new Response("ok");\n'
		});
		expect(world(routes, 'api/+layout.svelte')).toBe('strip'); // own chain: Kit default true
		const routes2 = tree({
			'+layout.ts': 'export const csr = false;\n',
			'+page.svelte': '<h1>home</h1>',
			'api/+layout.svelte': '<slot />'
		});
		expect(world(routes2, 'api/+layout.svelte')).toBe('island'); // own chain: root false
	});

	it('sibling-prefix dirs do not leak into a layout fold (docs vs docs-old)', () => {
		const routes = tree({
			'docs/+layout.svelte': '<slot />',
			'docs/+page.svelte': '<h1>docs</h1>',
			'docs-old/+page.ts': 'export const csr = false;\n',
			'docs-old/+page.svelte': '<h1>old</h1>'
		});
		// docs-old is NOT below docs/ — the docs layout must not see its csr=false.
		expect(world(routes, 'docs/+layout.svelte')).toBe('strip');
	});
});

// ── runtime set + cache ──────────────────────────────────────────────────────────────────────

describe('csrTrueRouteIds + cache', () => {
	it('root page maps to "/", groups stripped, multiple entries', () => {
		const routes = tree({
			'+page.svelte': '<h1>home</h1>',
			'(app)/dash/+page.svelte': '<h1>d</h1>',
			'blog/+page.ts': 'export const csr = false;\n',
			'blog/+page.svelte': '<h1>b</h1>'
		});
		expect(csrTrueRouteIds(routes).sort()).toEqual(['/', '/dash']);
	});

	it('clear_route_csr_cache picks up new declarations AND new pages', () => {
		const routes = tree({
			'+layout.svelte': '<slot />',
			'spa/+page.svelte': '<h1>spa</h1>'
		});
		expect(world(routes, '+layout.svelte')).toBe('strip');
		// a csr=false declaration appears
		writeFileSync(at(routes, 'spa/+page.ts'), 'export const csr = false;\n');
		clear_route_csr_cache();
		expect(world(routes, '+layout.svelte')).toBe('island');
		// a brand-new csr=true page appears
		mkdirSync(at(routes, 'landing'), { recursive: true });
		writeFileSync(at(routes, 'landing/+page.svelte'), '<h1>l</h1>');
		clear_route_csr_cache();
		expect(world(routes, '+layout.svelte')).toBe('shared');
		expect(csrTrueRouteIds(routes)).toEqual(['/landing']);
	});
});

// ── transform seam — what each world does to a layout's chrome islands ───────────────────────

const LAYOUT_HOST = `<script>
	import Header from '$lib/Header.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<Header />
<main>{@render children?.()}</main>
`;

function compile_layout(routeCsr: boolean | undefined) {
	return transformHost(LAYOUT_HOST, '/app/src/routes/+layout.svelte', {
		root: '/app',
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		ssr: true,
		virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
		devUrlFor: (p: string) => p,
		visibleMargin: '200px',
		presets: {},
		importKeys: {},
		idSalt: '',
		clientBindingStub: 'virtual:ogygia/client-binding-stub',
		routeCsr
	} as never) as { islands?: unknown[]; code?: string } | null;
}

describe('transform seam — route_csr tri-state on a layout host', () => {
	it('island world (false) and shared world (undefined) keep the chrome islands', () => {
		for (const rc of [false, undefined]) {
			const r = compile_layout(rc);
			expect(r?.islands?.length, `routeCsr=${String(rc)}`).toBeGreaterThan(0);
		}
	});
	it('strip world (true) hands the component to Kit as plain', () => {
		const r = compile_layout(true);
		// stripped output has no island registrations — Kit compiles + hydrates it inline
		expect(r?.islands?.length ?? 0).toBe(0);
		expect(r?.code ?? '').not.toContain('virtual:ogygia/wrapper');
	});
});
