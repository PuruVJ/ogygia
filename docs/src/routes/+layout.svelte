<script lang="ts">
	import '@fontsource-variable/newsreader/opsz.css';
	import '@fontsource-variable/newsreader/opsz-italic.css';
	import '@fontsource-variable/instrument-sans/wght.css';
	import '@fontsource-variable/instrument-sans/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono/wght.css';
	import '../app.css';
	import { OgygiaRouter } from 'ogygia';

	let { children } = $props();
</script>

<OgygiaRouter />
{@render children()}
