<script lang="ts">
	// The homepage runs without DocsShell, so there's no shell to provide ⌘K search. Mount ogygia's
	// Search component directly, pointed at the docs index (`base="/docs"`). The importer marks this
	// wrapper as an island, so Search's keybinding arms and its palette lazy-loads on first intent.
	import { Search } from 'ogygia/content';
</script>

<Search base="/docs" placeholder="Search docs" />
