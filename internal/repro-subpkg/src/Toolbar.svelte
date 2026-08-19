<script lang="ts">
	// Island HOST living in a workspace sub-package that does NOT depend on ogygia. The ogygia
	// transform injects `import { Region } from 'ogygia/internal'` here — building the app that consumes
	// this component must still resolve that injected import, via the plugin's self-reference (PKG_ROOT),
	// NOT from this package (which has no ogygia). This reproduces the real monorepo failure.
	import Bar from './Bar.svelte' with { wake: 'load' };
</script>

<div data-subpkg-toolbar>Toolbar from repro-subpkg → <Bar /></div>
