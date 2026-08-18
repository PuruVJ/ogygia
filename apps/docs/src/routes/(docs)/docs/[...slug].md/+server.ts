import { docs } from '$lib/docs.server';

// Every doc page as raw markdown at `/docs/<slug>.md` — the source text for models and copy-paste.
// The source rides on each entry (the markdown compiler injects a lazy `?raw` self-import), so there
// is no parallel glob here. Frontmatter stripped by default.
export const prerender = true;

export const { GET, entries } = docs.emit.raw();
