// Prerender the empty search page (the /search entry the home page links to); q-variants degrade to
// it on a static host, and the ⌘K palette does live client-side search anyway.
export const prerender = true;
