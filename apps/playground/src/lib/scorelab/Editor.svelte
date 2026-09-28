<script lang="ts">
	// The score lab's heavy widget: a real code editor (CodeMirror, several hundred KB of JS). Mounted
	// the same way on both twin pages; only how the page ships it differs.
	import { EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { defaultKeymap } from '@codemirror/commands';
	import { javascript } from '@codemirror/lang-javascript';
	import { html } from '@codemirror/lang-html';

	let { doc = 'const answer = 42;' }: { doc?: string } = $props();

	function editor(node: HTMLElement) {
		const view = new EditorView({
			parent: node,
			state: EditorState.create({ doc, extensions: [lineNumbers(), keymap.of(defaultKeymap), javascript(), html()] })
		});
		return () => view.destroy();
	}
</script>

<div data-score-editor {@attach editor}><pre>{doc}</pre></div>
