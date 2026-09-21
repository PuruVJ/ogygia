// The app's hooks.client.ts init runs on a csr=false page (Kit never boots there, so ogygia runs it),
// and is SKIPPED on a csr=true document (Kit runs it itself — never double-fire). This is what makes
// "the page behaves the same with and without ogygia": monitoring / third-party bootstraps in
// hooks.client load either way. The csr fact is read off `<meta name="ogygia-csr">` (KitBoot).
import { expect, test, afterEach } from 'vitest';
import { run_app_client_hooks } from '../../src/runtime/client-hooks.js';

function set_csr(value: 'true' | 'false' | null): void {
	document.head.querySelectorAll('meta[name="ogygia-csr"]').forEach((m) => m.remove());
	if (value !== null) {
		const meta = document.createElement('meta');
		meta.setAttribute('name', 'ogygia-csr');
		meta.setAttribute('content', value);
		document.head.appendChild(meta);
	}
}

afterEach(() => set_csr(null));

test('csr=false document: the app hooks.client init runs (ogygia is the client bootstrap)', async () => {
	set_csr('false');
	let ran = 0;
	run_app_client_hooks(async () => ({
		init: () => {
			ran++;
		}
	}));
	await expect.poll(() => ran, { timeout: 5000 }).toBe(1);
});

test('csr=true document: skipped — Kit runs hooks.client itself, so it must not double-fire', async () => {
	set_csr('true');
	let ran = 0;
	run_app_client_hooks(async () => ({
		init: () => {
			ran++;
		}
	}));
	// give the microtask chain a chance; it must stay 0
	await new Promise((r) => setTimeout(r, 300));
	expect(ran).toBe(0);
});

test('a hooks.client with no init export is a clean no-op (no throw)', async () => {
	set_csr('false');
	let loaded = false;
	run_app_client_hooks(async () => {
		loaded = true;
		return {}; // no init
	});
	await expect.poll(() => loaded, { timeout: 5000 }).toBe(true);
});

test("a failing init is caught, not thrown — it never blocks the page", async () => {
	set_csr('false');
	const errors: unknown[] = [];
	const real = console.error;
	console.error = (...a: unknown[]) => errors.push(a);
	try {
		run_app_client_hooks(async () => ({
			init: () => {
				throw new Error('boom');
			}
		}));
		await expect.poll(() => errors.length, { timeout: 5000 }).toBeGreaterThan(0);
		expect(String(errors[0])).toContain('hooks.client init failed');
	} finally {
		console.error = real;
	}
});
