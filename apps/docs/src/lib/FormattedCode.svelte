<script lang="ts">
	// A readonly code output that PRETTY-PRINTS its source (prettier, printWidth 60) before showing it in
	// CodeMirror. Shows the raw source immediately, then swaps in the formatted version when prettier
	// lands. On a syntax error it keeps the raw source.
	import CodeMirror from './CodeMirror.svelte';
	import { formatCode } from './prettier';

	let { doc, lang }: { doc: string; lang?: 'svelte' | 'ts' | 'js' | 'html' } = $props();

	let shown = $state('');
	$effect(() => {
		const raw = doc;
		shown = raw;
		if (!raw) return;
		let cancelled = false;
		formatCode(raw, lang)
			.then((f) => {
				if (!cancelled && typeof f === 'string') shown = f;
			})
			.catch(() => {
				/* keep the raw source */
			});
		return () => {
			cancelled = true;
		};
	});
</script>

<CodeMirror doc={shown} {lang} readonly />
