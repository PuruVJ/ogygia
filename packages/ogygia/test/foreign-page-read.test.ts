// FOREIGN PAGE READ (fragment federation, dev warning). A mounted MFE island hydrates inside the
// SHELL's document, where the `$app/state` / `$app/stores` shims read the shell's page singleton —
// the MFE's own page seed never crosses the fragment boundary. The shell runtime marks the foreign
// hydrate (`set_foreign_hydrate`) and the shims warn ONCE per island entry when a per-page field
// (data / params / route / form / error) is read; `url` / `status` / `state` stay silent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { set_foreign_hydrate } from '../src/current-region.js';
import { page } from '../src/shims/app-state.svelte.js';
import { page as page_store } from '../src/shims/app-stores.js';

const CMS = 'https://cms.internal';
/** Distinct entries per test: the warning is once-per-entry for the life of the module. */
const entry = (tag: string) => `${CMS}/_app/immutable/og-region.${tag}.js`;

afterEach(() => {
	set_foreign_hydrate(null);
	vi.restoreAllMocks();
});

describe('page reads inside a mounted MFE island', () => {
	it('warns once per island entry, naming the field, the entry, and the origin', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		set_foreign_hydrate({ origin: CMS, entry: entry('a') });
		void page.data;
		void page.data;
		void page.params; // same island → still one line
		expect(warn).toHaveBeenCalledTimes(1);
		const msg = String(warn.mock.calls[0][0]);
		expect(msg).toContain('[ogygia] page.data was read inside a mounted MFE island');
		expect(msg).toContain(entry('a'));
		expect(msg).toContain(`from ${CMS}`);
		expect(msg).toContain("SHELL's page");
		expect(msg).toContain('Pass the value as a prop');
	});

	it('a second island (another entry) gets its own line', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		set_foreign_hydrate({ origin: CMS, entry: entry('b') });
		void page.route;
		set_foreign_hydrate({ origin: CMS, entry: entry('c') });
		void page.form;
		void page.error;
		expect(warn).toHaveBeenCalledTimes(2);
		expect(String(warn.mock.calls[0][0])).toContain('page.route');
		expect(String(warn.mock.calls[1][0])).toContain('page.form');
	});

	it('stays silent for local islands, and for url / status / state on a foreign one', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		void page.data; // no foreign hydrate in flight → a local island
		set_foreign_hydrate({ origin: CMS, entry: entry('d') });
		void page.url;
		void page.status;
		void page.state;
		expect(warn).not.toHaveBeenCalled();
	});

	it('covers the `$app/stores` $page subscription too', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		set_foreign_hydrate({ origin: CMS, entry: entry('e') });
		const off = page_store.subscribe(() => {});
		off();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain('$page was read inside a mounted MFE island');
	});
});
