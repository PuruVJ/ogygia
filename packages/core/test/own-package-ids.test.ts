// REGRESSION (field report, Windows): the own-package root was the NATIVE path
// (`C:\…\node_modules\ogygia\`) while every check against it is a `startsWith` on a Vite module id
// (`C:/…/node_modules/ogygia/dist/region.js`) — so on Windows no id was ever "ogygia's own": its
// devtools/profiler `.svelte` got app registrations and its own `dist/region.js` warned that its marks
// were IGNORED. And on every platform the dev dep scan took ogygia's profiler UI as entries; ogygia is
// in `optimizeDeps.exclude`, the scanner could not resolve `./Shell.svelte` inside it, and the whole
// scan failed (nothing pre-bundled).
import { describe, test, expect } from 'vitest';
import {
	id_dir,
	scan_entry_pattern,
	PKG_ROOT_ID,
	OGYGIA_REGION_MODULES
} from '../dist/vite/paths.js';

describe('own-package ids', () => {
	test('a Windows root is the forward-slash prefix of the ids inside it', () => {
		const root = id_dir('C:\\Users\\dev\\node_modules\\ogygia\\');
		expect(root).toBe('C:/Users/dev/node_modules/ogygia/');
		expect('C:/Users/dev/node_modules/ogygia/dist/region.js'.startsWith(root)).toBe(true);
	});

	test('one trailing slash, with or without one given; a sibling package is not inside', () => {
		expect(id_dir('/x/node_modules/ogygia')).toBe('/x/node_modules/ogygia/');
		expect(id_dir('/x/node_modules/ogygia/')).toBe('/x/node_modules/ogygia/');
		expect(
			'/x/node_modules/ogygia-extra/index.js'.startsWith(id_dir('/x/node_modules/ogygia'))
		).toBe(false);
	});

	test('the package root and its precomputed module ids are posix, slash-terminated', () => {
		expect(PKG_ROOT_ID.endsWith('/')).toBe(true);
		expect(PKG_ROOT_ID.includes('\\')).toBe(false);
		for (const id of OGYGIA_REGION_MODULES) expect(id.startsWith(PKG_ROOT_ID)).toBe(true);
	});
});

describe('dep-scan entries', () => {
	test("ogygia's own islands are never an entry — on either separator", () => {
		expect(scan_entry_pattern(PKG_ROOT_ID + 'dist/profiler/ui/Compare.svelte')).toBeNull();
		const win_root = id_dir('C:\\dev\\node_modules\\ogygia');
		expect(
			scan_entry_pattern(
				'C:\\dev\\node_modules\\ogygia\\dist\\profiler\\ui\\Sidebar.svelte',
				win_root
			)
		).toBeNull();
	});

	test('an app island is, posix and glob-escaped', () => {
		expect(scan_entry_pattern('C:\\app\\src\\routes\\(shop)\\[id]\\Card.svelte', '/og/')).toBe(
			'C:/app/src/routes/\\(shop\\)/\\[id\\]/Card.svelte'
		);
	});
});
