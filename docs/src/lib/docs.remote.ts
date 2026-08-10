/**
 * Docs navigation as a Kit remote (devalue-safe metadata — no bodies).
 * Section + order are read off each entry's `filePath` (the `NN-` prefixes); the sidebar island
 * awaits `docNav()` and groups it. Bodies come from `docs.get()` in the route.
 */
import { withRemotes } from 'ogygia/content/server';
import { docs, type DocData } from './collections';
import { parseDocPath } from './toc-items';

// ONE definition (`docs` in collections.ts, browser-safe). `withRemotes` (server-only, imports
// $app/server) augments it with the Kit remotes — fine here in a .remote.ts. The `<DocData>` is
// explicit because `withRemotes` takes an opaque handle and can't infer the entry type from it.
export const docNav = withRemotes<DocData>(docs).list({
	map: (e) => {
		const { section, sectionOrder, order } = parseDocPath(e.filePath ?? '');
		return { slug: e.id, title: e.data.title, section, sectionOrder, order };
	}
});
