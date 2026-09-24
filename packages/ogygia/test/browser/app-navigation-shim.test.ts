// The `$app/navigation` shim follows the page shims' rule: on a Kit-booted document (the kit-page
// thread published Kit's real modules on the well-known symbol) every call goes to KIT's
// navigation; otherwise to the ogygia router. A customer's chips inside a live island on a Kit page
// called `goto()` and reached the ogygia router, which does not own that document — a full reload.
import { afterEach, expect, test, vi } from 'vitest';
import * as shim from '../../src/shims/app-navigation.js';

const KEY = Symbol.for('ogygia.kit-page');
const scope = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
	delete scope[KEY];
});

test('on a Kit-booted document, goto / invalidate / preload / the hooks go to Kit’s navigation', async () => {
	const navigation = {
		goto: vi.fn(async () => {}),
		invalidate: vi.fn(async () => {}),
		invalidateAll: vi.fn(async () => {}),
		preloadData: vi.fn(async () => ({ type: 'loaded' })),
		preloadCode: vi.fn(async () => {}),
		pushState: vi.fn(),
		replaceState: vi.fn(),
		disableScrollHandling: vi.fn(),
		beforeNavigate: vi.fn(),
		afterNavigate: vi.fn(),
		onNavigate: vi.fn()
	};
	scope[KEY] = { page: {}, navigating: { current: null }, navigation };

	await shim.goto('/somewhere', { replaceState: true });
	expect(navigation.goto).toHaveBeenCalledWith('/somewhere', { replaceState: true });
	await shim.invalidate('app:x');
	expect(navigation.invalidate).toHaveBeenCalledWith('app:x');
	await shim.invalidateAll();
	expect(navigation.invalidateAll).toHaveBeenCalled();
	await shim.preloadData('/next');
	expect(navigation.preloadData).toHaveBeenCalledWith('/next');
	await shim.preloadCode('/next');
	expect(navigation.preloadCode).toHaveBeenCalledWith('/next');
	shim.pushState('/p', { a: 1 });
	expect(navigation.pushState).toHaveBeenCalledWith('/p', { a: 1 });
	shim.replaceState('/r', { b: 2 });
	expect(navigation.replaceState).toHaveBeenCalledWith('/r', { b: 2 });
	shim.disableScrollHandling();
	expect(navigation.disableScrollHandling).toHaveBeenCalled();
	const before = () => {};
	const after = () => {};
	shim.beforeNavigate(before);
	shim.afterNavigate(after);
	expect(navigation.beforeNavigate).toHaveBeenCalledWith(before);
	expect(navigation.afterNavigate).toHaveBeenCalledWith(after);
	const on = () => {};
	shim.onNavigate(on);
	expect(navigation.onNavigate).toHaveBeenCalledWith(on);
});

// On a document ogygia owns, every call goes to the RUNNING RUNTIME's navigation handle — never to a
// router module the shim imports (island code importing the router split the runtime's boot into a
// dozen files; runtime/nav-handle.ts).
const NAV = Symbol.for('ogygia.nav');

test('without the Kit thread, calls go to the runtime’s navigation handle', async () => {
	const handle = {
		goto: vi.fn(async () => {}),
		invalidate: vi.fn(async () => {}),
		invalidateAll: vi.fn(async () => {}),
		preloadData: vi.fn(async () => ({ type: 'loaded' })),
		preloadCode: vi.fn(async () => {}),
		disableScrollHandling: vi.fn(),
		pushState: vi.fn(),
		replaceState: vi.fn(),
		beforeNavigate: vi.fn(() => () => {}),
		afterNavigate: vi.fn(() => () => {}),
		bust_page_cache: vi.fn()
	};
	scope[NAV] = handle;
	try {
		await shim.goto('/somewhere', { replaceState: true });
		expect(handle.goto).toHaveBeenCalledWith('/somewhere', { replaceState: true });
		await shim.invalidateAll();
		expect(handle.invalidateAll).toHaveBeenCalled();
		await shim.preloadData('/next');
		expect(handle.preloadData).toHaveBeenCalledWith('/next');
		const before = () => {};
		const off = shim.beforeNavigate(before);
		expect(handle.beforeNavigate).toHaveBeenCalledWith(before);
		expect(typeof off).toBe('function');
		shim.bust_page_cache();
		expect(handle.bust_page_cache).toHaveBeenCalled();
	} finally {
		delete scope[NAV];
	}
});

test('with no runtime at all, the browser fallback keeps goto’s contract: same-origin only', () => {
	delete scope[NAV];
	// A cross-origin goto without `external` throws — the same contract the router's goto has.
	expect(() => shim.goto('https://elsewhere.example/x')).toThrow(/same-origin/);
});
