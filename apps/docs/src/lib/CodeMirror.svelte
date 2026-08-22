<script lang="ts">
	// The ONE CodeMirror component — editable (the REPL editor) or `readonly` (every code output). Its
	// syntax colours are the site's own code theme (the ogygia-light / ogygia-dark Shiki palette in
	// src/lib/code/shiki-themes.ts), driven by `--cm-*` CSS vars with LIGHT as the default and dark under
	// prefers-color-scheme / [data-theme='dark'] — so it matches the docs everywhere and reads in both.
	//
	// CM is SSR-safe at module load; the view is built in a client-only $effect.
	import { untrack } from 'svelte';
	import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
	import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, indentUnit } from '@codemirror/language';
	import { javascript } from '@codemirror/lang-javascript';
	import { html } from '@codemirror/lang-html';
	import { svelte } from '@replit/codemirror-lang-svelte';
	import { tags as t } from '@lezer/highlight';

	let {
		doc,
		docKey,
		lang,
		readonly = false,
		oninput,
		oncursor,
		initialCursor = 0
	}: {
		doc: string;
		/** Filename — its extension picks the grammar (App.svelte / x.ts / x.js / x.html). */
		docKey?: string;
		/** Explicit grammar, overrides docKey. */
		lang?: 'svelte' | 'ts' | 'js' | 'html';
		readonly?: boolean;
		oninput?: (v: string) => void;
		/** Report the cursor head offset (for URL state). */
		oncursor?: (offset: number) => void;
		/** Restore the cursor to this offset once, on creation. */
		initialCursor?: number;
	} = $props();

	let el: HTMLDivElement;
	let view = $state<EditorView>();
	const langComp = new Compartment();

	function grammar(key: string | undefined, explicit: typeof lang) {
		const k = explicit ?? key ?? '';
		if (k === 'svelte' || k.endsWith('.svelte')) return svelte();
		if (k === 'ts' || k.endsWith('.ts')) return javascript({ typescript: true });
		if (k === 'js' || k.endsWith('.js') || k.endsWith('.mjs')) return javascript();
		if (k === 'html' || k.endsWith('.html')) return html();
		return javascript(); // sensible default for the compiled JS output
	}

	// Every colour is a --cm-* var → the editor tracks the site code theme with zero JS.
	const highlight = HighlightStyle.define([
		{ tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
		{ tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.self], color: 'var(--cm-keyword)' },
		{ tag: [t.string, t.special(t.string), t.attributeValue], color: 'var(--cm-string)' },
		{ tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--cm-constant)' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-fn)' },
		{ tag: [t.typeName, t.className, t.namespace, t.changed], color: 'var(--cm-type)' },
		{ tag: t.tagName, color: 'var(--cm-tag)' },
		{ tag: t.attributeName, color: 'var(--cm-attr)' },
		{ tag: [t.angleBracket, t.punctuation, t.separator, t.brace, t.bracket, t.paren, t.derefOperator, t.operator], color: 'var(--cm-punct)' },
		{ tag: [t.propertyName, t.variableName, t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--cm-name)' },
		{ tag: [t.meta, t.documentMeta], color: 'var(--cm-comment)' },
		{ tag: t.regexp, color: 'var(--cm-string)' },
		{ tag: t.invalid, color: 'var(--cm-invalid)' }
	]);

	const chrome = EditorView.theme({
		'&': { color: 'var(--cm-fg)', backgroundColor: 'transparent' },
		'.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', fontSize: '12.5px', lineHeight: '1.6' },
		'.cm-content': { caretColor: 'var(--cm-caret)', padding: '10px 0' },
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret)', borderLeftWidth: '2px' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--cm-selection)' },
		'.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
		'.cm-gutters': { backgroundColor: 'transparent', color: 'var(--cm-gutter)', border: 'none' },
		'.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)', color: 'var(--cm-fg)' },
		'.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '2ch' },
		'.cm-matchingBracket': { backgroundColor: 'var(--cm-bracket)', outline: '1px solid var(--cm-bracket-border)' },
		'&.cm-focused': { outline: 'none' }
	});

	// Mark OUR OWN syntax — the ogygia dials (import attributes), macros, and virtual ids — with a faint
	// accent box, so at a glance you see what's ogygia vs plain Svelte/JS.
	const OG_PATTERNS = [/\bwith\s*\{[^}]*\}/g, /\bimport\.meta\.og\.\w+/g, /virtual:ogygia\/[\w/.-]+/g];
	const og_mark = Decoration.mark({ class: 'cm-og-syntax' });
	const ogHighlighter = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const marks: { from: number; to: number }[] = [];
				for (const { from, to } of view.visibleRanges) {
					const text = view.state.doc.sliceString(from, to);
					for (const pat of OG_PATTERNS) {
						pat.lastIndex = 0;
						let m: RegExpExecArray | null;
						while ((m = pat.exec(text))) marks.push({ from: from + m.index, to: from + m.index + m[0].length });
					}
				}
				marks.sort((a, b) => a.from - b.from || a.to - b.to);
				const builder = new RangeSetBuilder<Decoration>();
				let last = -1;
				for (const mk of marks) {
					if (mk.from < last) continue; // RangeSetBuilder needs sorted, non-overlapping
					builder.add(mk.from, mk.to, og_mark);
					last = mk.to;
				}
				return builder.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);

	function extensions(key: string | undefined, l: typeof lang) {
		const base = [
			lineNumbers(),
			langComp.of(grammar(key, l)),
			syntaxHighlighting(highlight),
			ogHighlighter,
			chrome,
			EditorView.lineWrapping,
			EditorState.tabSize.of(2), // render tabs (svelte's compiled output is tab-indented) at 2 cols
			EditorState.readOnly.of(readonly),
			EditorView.editable.of(!readonly)
		];
		if (readonly) return base;
		return [
			...base.slice(0, 1),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			history(),
			drawSelection(),
			dropCursor(),
			indentOnInput(),
			bracketMatching(),
			indentUnit.of('\t'),
			...base.slice(1),
			keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged && !syncing) oninput?.(u.state.doc.toString());
				if ((u.selectionSet || u.docChanged) && !syncing) oncursor?.(u.state.selection.main.head);
			})
		];
	}

	let syncing = false;

	$effect(() => {
		const init_doc = untrack(() => doc);
		const ic = untrack(() => initialCursor);
		const v = new EditorView({
			state: EditorState.create({
				doc: init_doc,
				selection: !readonly && ic > 0 && ic <= init_doc.length ? { anchor: ic } : undefined,
				extensions: extensions(untrack(() => docKey), untrack(() => lang))
			}),
			parent: el
		});
		view = v;
		return () => {
			v.destroy();
			view = undefined;
		};
	});

	// External doc changes flow in (file switch, recompiled output, preset load) — skip when CM holds it.
	$effect(() => {
		const next = doc;
		if (!view) return;
		const cur = view.state.doc.toString();
		if (cur === next) return;
		syncing = true;
		view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
		syncing = false;
	});

	// Grammar swap on file/lang change.
	$effect(() => {
		const key = docKey;
		const l = lang;
		if (!view) return;
		view.dispatch({ effects: langComp.reconfigure(grammar(key, l)) });
	});
</script>

<div class="cm-host" class:readonly bind:this={el} data-obs-editor={readonly ? undefined : true}></div>

<style>
	.cm-host {
		display: block;
		min-height: 0;
		overflow: auto;

		/* ── LIGHT is the default (the docs default; ogygia-light Shiki palette) ── */
		--cm-fg: #121a16;
		--cm-name: #121a16;
		--cm-caret: var(--accent, #0f7a4f);
		--cm-selection: color-mix(in oklab, var(--accent, #0f7a4f) 18%, transparent);
		--cm-active-line: color-mix(in oklab, var(--accent, #0f7a4f) 6%, transparent);
		--cm-gutter: #7a8c82;
		--cm-comment: #7a8c82;
		--cm-keyword: #0f7a4f;
		--cm-string: #1a6b4a;
		--cm-tag: #0a5c3b;
		--cm-fn: #2f4f7a;
		--cm-type: #5a3d7a;
		--cm-constant: #0e6e8c;
		--cm-attr: #0e6e8c;
		--cm-punct: #4a5c52;
		--cm-invalid: #8b3a2a;
		--cm-bracket: color-mix(in oklab, var(--accent, #0f7a4f) 22%, transparent);
		--cm-bracket-border: color-mix(in oklab, var(--accent, #0f7a4f) 45%, transparent);
	}
	.cm-host.readonly {
		min-height: auto;
	}

	/* ── DARK: system default, then explicit toggle (ogygia-dark Shiki palette) ── */
	:global(:root:not([data-theme='light'])) .cm-host {
		@media (prefers-color-scheme: dark) {
			--cm-fg: #e6eee9;
			--cm-name: #e6eee9;
			--cm-gutter: #708278;
			--cm-comment: #708278;
			--cm-keyword: #6fe3b0;
			--cm-string: #9fc9b0;
			--cm-tag: #8ff0c6;
			--cm-fn: #a8b8e8;
			--cm-type: #c4a8e0;
			--cm-constant: #7ec8e0;
			--cm-attr: #7ec8e0;
			--cm-punct: #9aaba1;
			--cm-invalid: #f0c9a0;
		}
	}
	:global(:root[data-theme='dark']) .cm-host {
		--cm-fg: #e6eee9;
		--cm-name: #e6eee9;
		--cm-gutter: #708278;
		--cm-comment: #708278;
		--cm-keyword: #6fe3b0;
		--cm-string: #9fc9b0;
		--cm-tag: #8ff0c6;
		--cm-fn: #a8b8e8;
		--cm-type: #c4a8e0;
		--cm-constant: #7ec8e0;
		--cm-attr: #7ec8e0;
		--cm-punct: #9aaba1;
		--cm-invalid: #f0c9a0;
	}

	.cm-host :global(.cm-editor) {
		width: 100%;
	}
	/* ogygia's own syntax (dials / macros / virtual ids) — a faint accent box. */
	.cm-host :global(.cm-og-syntax) {
		background: color-mix(in oklab, var(--accent, #0f7a4f) 12%, transparent);
		border-radius: 3px;
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent, #0f7a4f) 24%, transparent);
		padding: 1px 0;
	}
	/* Editable editor fills its flex parent; readonly blocks grow to fit their code. */
	.cm-host:not(.readonly) {
		height: 100%;
	}
	.cm-host:not(.readonly) :global(.cm-editor) {
		height: 100%;
	}
	.cm-host.readonly {
		overflow: visible;
	}
	.cm-host.readonly :global(.cm-editor) {
		height: auto;
	}
	.cm-host.readonly :global(.cm-scroller) {
		overflow: visible;
	}
</style>
