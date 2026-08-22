<script lang="ts">
	// The Observatory's editor — CodeMirror 6, driven by the active file. Language is picked per
	// extension (.svelte / .ts|.js / .html); colours come entirely from `--cm-*` CSS vars (defined
	// below for dark + light), so the editor re-themes with the shell the same way the preview does.
	//
	// CM is SSR-safe at module load (verified) but only touches the DOM inside the mount `$effect`,
	// which runs client-only — so this component renders an empty host during the island's SSR pass
	// and comes alive on hydrate.
	import { untrack } from 'svelte';
	import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from '@codemirror/view';
	import { EditorState, Compartment } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, indentUnit } from '@codemirror/language';
	import { javascript } from '@codemirror/lang-javascript';
	import { html } from '@codemirror/lang-html';
	import { svelte } from '@replit/codemirror-lang-svelte';
	import { tags as t } from '@lezer/highlight';

	let { doc, docKey, oninput }: { doc: string; docKey: string; oninput: (v: string) => void } = $props();

	let el: HTMLDivElement;
	let view = $state<EditorView>();
	const lang = new Compartment();

	function lang_for(key: string) {
		if (key.endsWith('.svelte')) return svelte();
		if (key.endsWith('.ts')) return javascript({ typescript: true });
		if (key.endsWith('.js') || key.endsWith('.mjs')) return javascript();
		if (key.endsWith('.html')) return html();
		return [];
	}

	// Every colour is a CSS var → the editor follows the shell theme with zero JS.
	const highlight = HighlightStyle.define([
		{ tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
		{ tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.self], color: 'var(--cm-keyword)' },
		{ tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--cm-string)' },
		{ tag: [t.number, t.bool, t.null, t.atom], color: 'var(--cm-number)' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-function)' },
		{ tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--cm-def)' },
		{ tag: [t.typeName, t.className, t.namespace, t.changed], color: 'var(--cm-type)' },
		{ tag: t.tagName, color: 'var(--cm-tag)' },
		{ tag: t.attributeName, color: 'var(--cm-attr)' },
		{ tag: [t.angleBracket, t.punctuation, t.separator, t.brace, t.bracket, t.paren, t.derefOperator], color: 'var(--cm-punct)' },
		{ tag: [t.operator, t.operatorKeyword], color: 'var(--cm-operator)' },
		{ tag: [t.propertyName, t.variableName], color: 'var(--cm-variable)' },
		{ tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--cm-constant)' },
		{ tag: [t.meta, t.documentMeta], color: 'var(--cm-meta)' },
		{ tag: t.regexp, color: 'var(--cm-regex)' },
		{ tag: t.invalid, color: 'var(--cm-invalid)' }
	]);

	const chrome = EditorView.theme(
		{
			'&': { color: 'var(--cm-fg)', backgroundColor: 'transparent', height: '100%' },
			'.cm-scroller': { fontFamily: 'var(--obs-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', fontSize: '13px', lineHeight: '1.65' },
			'.cm-content': { caretColor: 'var(--cm-caret)', padding: '10px 0' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret)', borderLeftWidth: '2px' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--cm-selection)' },
			'.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
			'.cm-gutters': { backgroundColor: 'transparent', color: 'var(--cm-gutter)', border: 'none' },
			'.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)', color: 'var(--cm-fg)' },
			'.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '2ch' },
			'.cm-foldGutter .cm-gutterElement': { padding: '0 2px', opacity: '0.5' },
			'.cm-matchingBracket': { backgroundColor: 'var(--cm-bracket)', outline: '1px solid var(--cm-bracket-border)' },
			'&.cm-focused': { outline: 'none' }
		},
		{ dark: true }
	);

	function extensions(key: string) {
		return [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			history(),
			drawSelection(),
			dropCursor(),
			indentOnInput(),
			bracketMatching(),
			indentUnit.of('\t'),
			EditorState.tabSize.of(2),
			EditorState.allowMultipleSelections.of(true),
			lang.of(lang_for(key)),
			syntaxHighlighting(highlight),
			chrome,
			keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged && !syncing) oninput(u.state.doc.toString());
			})
		];
	}

	let syncing = false;

	// Create once (client-only). Read doc/docKey untracked so keystrokes don't rebuild the view.
	$effect(() => {
		const v = new EditorView({
			state: EditorState.create({ doc: untrack(() => doc), extensions: extensions(untrack(() => docKey)) }),
			parent: el
		});
		view = v;
		return () => {
			v.destroy();
			view = undefined;
		};
	});

	// External doc changes (file switch, preset load, share import) flow in; skip when CM already holds it.
	$effect(() => {
		const next = doc;
		if (!view) return;
		const cur = view.state.doc.toString();
		if (cur === next) return;
		syncing = true;
		view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
		syncing = false;
	});

	// File switch → swap the language grammar.
	$effect(() => {
		const key = docKey;
		if (!view) return;
		view.dispatch({ effects: lang.reconfigure(lang_for(key)) });
	});
</script>

<div class="cm-host" bind:this={el} data-obs-editor></div>

<style>
	.cm-host {
		flex: 1;
		min-height: 240px;
		overflow: auto;

		/* ── dark (default — matches the current Observatory shell) ── */
		--cm-fg: #d6deeb;
		--cm-caret: var(--obs-accent, #7dd3fc);
		--cm-selection: rgba(125, 211, 252, 0.18);
		--cm-active-line: rgba(148, 163, 184, 0.06);
		--cm-gutter: #56637a;
		--cm-comment: #637777;
		--cm-keyword: #c792ea;
		--cm-string: #a5d6a7;
		--cm-number: #f78c6c;
		--cm-function: #82aaff;
		--cm-def: #82aaff;
		--cm-type: #ffcb6b;
		--cm-tag: #f07178;
		--cm-attr: #ffcb6b;
		--cm-punct: #89ddff;
		--cm-operator: #89ddff;
		--cm-variable: #d6deeb;
		--cm-constant: #f78c6c;
		--cm-meta: #89ddff;
		--cm-regex: #c3e88d;
		--cm-invalid: #ef5350;
		--cm-bracket: rgba(130, 170, 255, 0.22);
		--cm-bracket-border: rgba(130, 170, 255, 0.5);
	}

	/* ── light (when the docs shell sets data-theme="light") ── */
	:global(:root[data-theme='light']) .cm-host {
		--cm-fg: #24292f;
		--cm-caret: var(--obs-accent, #0969da);
		--cm-selection: rgba(84, 174, 255, 0.22);
		--cm-active-line: rgba(0, 0, 0, 0.035);
		--cm-gutter: #8c959f;
		--cm-comment: #6e7781;
		--cm-keyword: #cf222e;
		--cm-string: #0a3069;
		--cm-number: #0550ae;
		--cm-function: #8250df;
		--cm-def: #953800;
		--cm-type: #953800;
		--cm-tag: #116329;
		--cm-attr: #0550ae;
		--cm-punct: #24292f;
		--cm-operator: #cf222e;
		--cm-variable: #24292f;
		--cm-constant: #0550ae;
		--cm-meta: #116329;
		--cm-regex: #0a3069;
		--cm-invalid: #cf222e;
		--cm-bracket: rgba(84, 174, 255, 0.28);
		--cm-bracket-border: rgba(84, 174, 255, 0.6);
	}

	.cm-host :global(.cm-editor) {
		height: 100%;
	}
</style>
