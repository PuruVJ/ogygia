<script lang="ts">
	// The no-JS search fallback the Shell's ⌘K trigger links to (`href="/search"`). The live search is
	// the ⌘K palette (a client island over the static search.json); this prerendered page is the form
	// entry point. Kept static — a prerendered page can't read `?q=`, and the palette is the real UX.
	import { SearchPage } from 'ogygia/content';
</script>

<SearchPage title="Search the playground" />
