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
	import { autocompletion, completionKeymap, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
	import { javascript } from '@codemirror/lang-javascript';
	import { html } from '@codemirror/lang-html';
	import { svelte } from '@replit/codemirror-lang-svelte';
	import { markdown } from '@codemirror/lang-markdown';
	import { LanguageDescription } from '@codemirror/language';
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
		// Content pages: markdown highlighting with per-fence code languages. `.svx` is markdown that
		// hosts Svelte, so untagged fences default to svelte and `<script>`/tags nest through markdown's
		// HTML handling — a pragmatic "markdown + svelte" blend without a bespoke grammar.
		if (k === 'md' || k.endsWith('.md')) return markdown({ codeLanguages: MD_CODE_LANGS });
		if (k === 'svx' || k.endsWith('.svx')) return markdown({ codeLanguages: MD_CODE_LANGS, defaultCodeLanguage: svelte() });
		return javascript(); // sensible default for the compiled JS output
	}
	// Fenced-code + embedded languages inside markdown/svx, resolved by info-string to the grammars we
	// already ship (loaded lazily by @codemirror/lang-markdown when a matching fence appears).
	const MD_CODE_LANGS = [
		LanguageDescription.of({ name: 'javascript', alias: ['js', 'mjs', 'jsx'], load: async () => javascript() }),
		LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], load: async () => javascript({ typescript: true }) }),
		LanguageDescription.of({ name: 'svelte', load: async () => svelte() }),
		LanguageDescription.of({ name: 'html', alias: ['htm'], load: async () => html() })
	];

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
		// Markdown / svx prose tags (so a `.md`/`.svx` file isn't near-monochrome): headings + emphasis
		// carry weight/slant; links, inline code, and the structural markers (`#`, `*`, `>`) get colour.
		{ tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: 'var(--cm-tag)', fontWeight: '600' },
		{ tag: t.strong, fontWeight: '600' },
		{ tag: t.emphasis, fontStyle: 'italic' },
		{ tag: t.strikethrough, textDecoration: 'line-through' },
		{ tag: [t.link, t.url], color: 'var(--cm-fn)' },
		{ tag: t.monospace, color: 'var(--cm-string)' },
		{ tag: t.quote, color: 'var(--cm-comment)', fontStyle: 'italic' },
		{ tag: [t.processingInstruction, t.list, t.contentSeparator], color: 'var(--cm-punct)' },
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
	// `[^{}]` matches a dial's contents (multi-line after Format included) but NO nested braces — so an
	// UNCLOSED `with {` stops at the next brace (e.g. markup `start={`) instead of running away.
	const OG_PATTERNS = [/\bwith\s*\{[^{}]*\}/g, /\bimport\.meta\.og\.\w+/g, /virtual:ogygia\/[\w/.-]+/g];
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

	// ── Autocomplete for OUR syntax: import.meta.og.* macros + the dial import-attributes ──
	const MACROS: Completion[] = [
		{ label: 'loader', type: 'method', detail: 'content loaders', info: '.markdown(dir) · .folder(dir) · .json(dir) · .git(spec)' },
		{ label: 'code', type: 'method', detail: 'highlight a snippet', info: 'import.meta.og.code(src, lang, meta?)' },
		{ label: 'md', type: 'method', detail: 'inline markdown', info: 'import.meta.og.md(text)' },
		{ label: 'regions', type: 'method', detail: 'glob region imports', info: "import.meta.og.regions('./blocks/*.svelte')" },
		{ label: 'wire', type: 'method', detail: 'live-class wire codec', info: 'static wire = import.meta.og.wire({ encode, decode })' },
		{ label: 'bake', type: 'method', detail: 'run at build, inline the result', info: 'import.meta.og.bake(() => …)' },
		{ label: 'asRegion', type: 'method', detail: 'named/barrel import → island', info: 'import.meta.og.asRegion(Comp, { wake: "load" })' }
	];
	// Picking a dial key drops in `key: ''` with the cursor between the quotes. Enum dials (wake/render)
	// then pop their value list immediately (startCompletion) — pick key, pick value, done.
	function dial_apply(key: string, popValues: boolean) {
		return (view: EditorView, _c: Completion, from: number, to: number) => {
			const insert = `${key}: ''`;
			const cursor = from + key.length + 3; // between the two quotes: `key: '|'`
			view.dispatch({ changes: { from, to, insert }, selection: { anchor: cursor } });
			if (popValues) startCompletion(view);
		};
	}
	const DIAL_KEYS: Completion[] = [
		{ label: 'wake', type: 'property', detail: 'when JS runs / HTML fetches', apply: dial_apply('wake', true) },
		{ label: 'render', type: 'property', detail: 'where the HTML comes from', apply: dial_apply('render', true) },
		{ label: 'region', type: 'property', detail: 'held marker', apply: "region: 'raw'" },
		{ label: 'keep', type: 'property', detail: 'keep node + $state across nav', apply: dial_apply('keep', false) },
		{ label: 'preset', type: 'property', detail: 'named dial bundle', apply: dial_apply('preset', false) },
		{ label: 'margin', type: 'property', detail: 'IntersectionObserver rootMargin', apply: dial_apply('margin', false) }
	];
	const vals = (xs: [string, string][]): Completion[] => xs.map(([label, detail]) => ({ label, type: 'enum', detail }));
	const WAKE_VALS = vals([
		['load', 'on hydrate'],
		['idle', 'requestIdleCallback'],
		['visible', 'on scroll into view'],
		['interaction', 'on first pointer/key'],
		['none', 'frozen — a lake, ships no JS']
	]);
	const RENDER_VALS = vals([
		['static', 'inline in the SSR pass (default)'],
		['deferred', 'fetched from a signed endpoint'],
		['live', 'baked, revalidates in background']
	]);

	// The filter range starts AFTER any opening quote (so the labels — which carry no quote — actually
	// match what's typed; including the quote made CM filter every option out). Apply supplies the quotes
	// the text doesn't already have: none typed → `'value'`; opening quote only → `value'`; both quotes
	// already present (cursor between them) → bare `value`.
	function quoted_values(ctx: CompletionContext, m: RegExpExecArray, options: Completion[]): CompletionResult {
		const q = m[1] || "'";
		const hasQuote = !!m[1];
		const next = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 1);
		const closeAhead = next === "'" || next === '"';
		const wrap = (label: string) =>
			hasQuote ? (closeAhead ? label : `${label}${q}`) : `${q}${label}${q}`;
		return {
			from: ctx.pos - m[2].length,
			options: options.map((o) => ({ ...o, apply: wrap(o.label) })),
			validFor: /^\w*$/
		};
	}

	function og_complete(context: CompletionContext): CompletionResult | null {
		const before = context.state.doc.sliceString(Math.max(0, context.pos - 300), context.pos);
		const macro = /import\.meta\.og\.(\w*)$/.exec(before);
		if (macro) return { from: context.pos - macro[1].length, options: MACROS, validFor: /^\w*$/ };
		const withOpen = /\bwith\s*\{[^{}]*$/.exec(before);
		if (withOpen) {
			const inner = withOpen[0];
			const wakeV = /\bwake\s*:\s*(['"]?)(\w*)$/.exec(inner);
			if (wakeV) return quoted_values(context, wakeV, WAKE_VALS);
			const renderV = /\brender\s*:\s*(['"]?)(\w*)$/.exec(inner);
			if (renderV) return quoted_values(context, renderV, RENDER_VALS);
			const regionV = /\bregion\s*:\s*(['"]?)(\w*)$/.exec(inner);
			if (regionV) return quoted_values(context, regionV, vals([['raw', 'HTML only — ships no JS']]));
			const key = /(\w*)$/.exec(inner)![1];
			return { from: context.pos - key.length, options: DIAL_KEYS, validFor: /^\w*$/ };
		}
		return null;
	}

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
			autocompletion({ activateOnTyping: true, icons: false }),
			EditorState.languageData.of(() => [{ autocomplete: og_complete }]),
			...base.slice(1),
			keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged && !syncing) oninput?.(u.state.doc.toString());
				if ((u.selectionSet || u.docChanged) && !syncing) oncursor?.(u.state.selection.main.head);
			})
		];
	}

	let syncing = false;

	// Each file keeps its OWN EditorState (doc + undo history + selection), keyed by docKey — so undo
	// never crosses files. Switching stashes the current state and restores the target's.
	const doc_states = new Map<string, EditorState>();
	let prev_key: string | undefined;
	function make_state(text: string, key: string | undefined, l: typeof lang, cursor: number): EditorState {
		return EditorState.create({
			doc: text,
			selection: !readonly && cursor > 0 && cursor <= text.length ? { anchor: cursor } : undefined,
			extensions: extensions(key, l)
		});
	}

	$effect(() => {
		const key = untrack(() => docKey);
		const st = make_state(untrack(() => doc), key, untrack(() => lang), untrack(() => initialCursor));
		if (key) doc_states.set(key, st);
		prev_key = key;
		const v = new EditorView({ state: st, parent: el });
		view = v;
		return () => {
			v.destroy();
			view = undefined;
			doc_states.clear();
		};
	});

	// Doc/file sync. On a FILE switch (docKey change) stash the current file's full state and restore the
	// target's own (its undo stack comes back). A restored state whose content no longer matches — e.g. a
	// preset reloaded that file — is discarded for a fresh one. On an external change to the SAME file
	// (recompiled output, __OBS_SOURCE.set), patch the doc in place.
	$effect(() => {
		const key = docKey;
		const text = doc;
		const l = lang;
		if (!view) return;
		if (key !== prev_key) {
			if (prev_key) doc_states.set(prev_key, view.state);
			prev_key = key;
			let st = key ? doc_states.get(key) : undefined;
			if (!st || st.doc.toString() !== text) st = make_state(text, key, l, 0);
			syncing = true;
			view.setState(st);
			syncing = false;
			return;
		}
		const cur = view.state.doc.toString();
		if (cur === text) return;
		syncing = true;
		view.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
		syncing = false;
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
