/**
 * THE PAGE'S STYLES, as the browser holds them: every stylesheet (linked or inline), its rules,
 * its size, whether it held the first paint, and two things only the live page can answer:
 *
 * - **unscoped components**: the build marks a component whose scoped CSS it could not compile
 *   (unscoped-css.ts). Its rules then apply page-wide. The CSSOM drops comments, so the marker is
 *   read from the sheet's text (inline: the node; linked: one fetch, from the HTTP cache).
 * - **rules that match nothing here**: each style rule's selector, with states and pseudo-elements
 *   taken off (`:hover`, `::before`), tried against the document. Content that appears later (a
 *   menu, a dialog, an island not yet rendered) counts as matching nothing, so it is a hint.
 *
 * Devtools' own UI lives in a shadow root and never shows here. Runs on demand (the Page tab), not
 * on a hot path.
 */
import { find_unscoped, unscoped_finding, type UnscopedStyles } from '../unscoped-css.js';
import { tool_fetch, tool_made } from '../tool-fetches.js';
import { paint_blocker } from '../runtime/render-blocking.js';

export interface SheetRow {
	/** the file name, or `inline <style>` */
	label: string;
	href: string | null;
	rules: number;
	/** decoded bytes: the response's (resource timing) or the inline text's */
	bytes: number;
	/** the browser waited on it before the first paint (resource timing's own verdict) */
	blocking: boolean;
	/** rules whose selectors match nothing on the page now (null until checked) */
	unmatched: number | null;
	/** their text's size, a stand-in for the bytes they cost */
	unmatched_bytes: number | null;
	/** a region / router stylesheet ogygia linked */
	ogygia: boolean;
}

export interface StylesReport {
	sheets: SheetRow[];
	rules: number;
	bytes: number;
	unmatched: number;
	unmatched_bytes: number;
	/** examples of selectors that match nothing, biggest rules first */
	examples: string[];
	unscoped: (UnscopedStyles & { sheet: string })[];
	/** sheets whose rules could not be read (another origin without CORS) */
	unreadable: number;
}

export interface StylesFinding {
	code: string;
	severity: 'warn' | 'info';
	message: string;
	fix?: string;
}

// states a selector depends on that the page is not in right now; taken off before matching
const STATES = [':hover', ':focus-visible', ':focus-within', ':focus', ':active', ':visited', ':target', ':open', ':popover-open', ':modal', ':user-invalid', ':user-valid', ':autofill'];

/** Split a selector list on its top-level commas (`:is(a, b)` stays whole). */
export function split_selectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === '(' || c === '[') depth++;
		else if (c === ')' || c === ']') depth--;
		else if (c === ',' && depth === 0) {
			out.push(list.slice(from, i).trim());
			from = i + 1;
		}
	}
	out.push(list.slice(from).trim());
	return out.filter(Boolean);
}

/** A selector with its pseudo-elements and momentary states taken off, ready to try against the
 *  document. `''` when nothing is left to match (a bare `::selection`): that one counts as used. */
export function matchable(sel: string): string {
	let s = sel;
	// pseudo-elements: `::before`, `::part(x)`, `::-webkit-scrollbar` — cut each to the next space,
	// combinator or end (they sit at the end of a compound)
	let at = s.indexOf('::');
	while (at !== -1) {
		let end = at + 2;
		let depth = 0;
		while (end < s.length) {
			const c = s[end];
			if (c === '(') depth++;
			else if (c === ')') depth--;
			else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~' || c === ',')) break;
			end++;
		}
		s = s.slice(0, at) + s.slice(end);
		at = s.indexOf('::');
	}
	for (const st of STATES) {
		let i = s.indexOf(st);
		while (i !== -1) {
			const next = s[i + st.length];
			// a whole pseudo-class only (`:focus` must not eat the start of `:focus-visible`)
			if (next === undefined || !(next === '-' || (next >= 'a' && next <= 'z'))) s = s.slice(0, i) + s.slice(i + st.length);
			else i += st.length;
			i = s.indexOf(st, i);
		}
	}
	s = s.trim();
	// a compound that lost everything (`a > :hover` → `a >`): match what is left of the chain
	while (s.endsWith('>') || s.endsWith('+') || s.endsWith('~')) s = s.slice(0, -1).trim();
	return s;
}

function file_of(href: string): string {
	const path = href.split('?')[0].split('#')[0];
	return path.slice(path.lastIndexOf('/') + 1) || href;
}

/** Devtools' own component styles: on the dev server Vite injects them into the page's <head>
 *  (the panel's markup lives in a shadow root, so every one of their rules matches nothing here). */
function own_sheet(node: Element | null): boolean {
	const id = node?.getAttribute('data-vite-dev-id');
	return !!id && id.includes('ogygia') && id.includes('/devtools/');
}

/** A sheet that styles the devtools panel and nothing on the page: in a build the panel's CSS is a
 *  linked file in the document, whatever its name. Its rules match inside the panel's shadow root
 *  and never in the document. Every rule is tried (which of the panel's parts are showing depends
 *  on its open tab), stopping at the first one the page itself uses. */
function styles_the_panel(rules: CSSRuleList, doc: Document, panel: ShadowRoot | null | undefined): boolean {
	if (!panel) return false;
	let in_panel = false;
	let stop = false;
	each_style_rule(rules, (rule) => {
		if (stop) return;
		for (const part of split_selectors((rule as CSSStyleRule).selectorText)) {
			const m = matchable(part);
			if (!m) continue;
			try {
				if (doc.querySelector(m)) {
					stop = true;
					in_panel = false;
					return;
				}
				if (panel.querySelector(m)) in_panel = true;
			} catch {
				/* a selector this browser cannot query */
			}
		}
	});
	return in_panel;
}

type Walk = (rule: CSSRule) => void;
function each_style_rule(list: CSSRuleList, fn: Walk) {
	for (let i = 0; i < list.length; i++) {
		const r = list[i];
		if ('selectorText' in r) fn(r);
		// @media / @supports / @layer / @container blocks, and nested rules
		const inner = (r as CSSGroupingRule).cssRules;
		if (inner && inner.length) each_style_rule(inner, fn);
	}
}

/** Read the page's stylesheets. `match: true` also tries every selector against the document. */
export function read_styles(doc: Document = document, opts: { match?: boolean } = {}): StylesReport {
	const res = new Map<string, PerformanceResourceTiming>();
	for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) if (!tool_made(e)) res.set(e.name, e);
	const sheets: SheetRow[] = [];
	const examples: { sel: string; len: number }[] = [];
	let unreadable = 0;
	const blocks = paint_blocker();
	const panel = doc.querySelector('[data-ogygia-devtools-host]')?.shadowRoot;
	for (const sheet of Array.from(doc.styleSheets)) {
		const node = sheet.ownerNode as Element | null;
		if (own_sheet(node)) continue;
		const href = sheet.href;
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			unreadable++;
			continue;
		}
		if (styles_the_panel(rules, doc, panel)) continue;
		const r = href ? res.get(href) : undefined;
		const row: SheetRow = {
			// (a dev server's injected <style> says which file it came from)
			label: href ? file_of(href) : node?.getAttribute('data-vite-dev-id') ? file_of(node.getAttribute('data-vite-dev-id')!) : 'inline <style>',
			href,
			rules: 0,
			bytes: href ? (r?.decodedBodySize ?? 0) : (node?.textContent?.length ?? 0),
			blocking: !!r && blocks(r),
			unmatched: opts.match ? 0 : null,
			unmatched_bytes: opts.match ? 0 : null,
			ogygia: !!node && (node.hasAttribute('data-ogygia-region-css') || node.hasAttribute('data-ogygia-rcss') || (href ?? '').includes('og-rcss'))
		};
		each_style_rule(rules, (rule) => {
			row.rules++;
			if (!opts.match) return;
			const text = (rule as CSSStyleRule).selectorText;
			// a nested rule's `&` needs its parent to mean anything: count it as used
			if (text.includes('&')) return;
			let hit = false;
			for (const part of split_selectors(text)) {
				const m = matchable(part);
				if (!m) {
					hit = true;
					break;
				}
				try {
					if (doc.querySelector(m)) {
						hit = true;
						break;
					}
				} catch {
					// a selector this browser cannot query (a vendor pseudo): do not call it unused
					hit = true;
					break;
				}
			}
			if (!hit) {
				row.unmatched!++;
				const len = rule.cssText.length;
				row.unmatched_bytes! += len;
				examples.push({ sel: text, len });
			}
		});
		sheets.push(row);
	}
	const sum = (k: 'rules' | 'bytes' | 'unmatched' | 'unmatched_bytes') => sheets.reduce((s, x) => s + (x[k] ?? 0), 0);
	examples.sort((a, b) => b.len - a.len);
	return {
		sheets: sheets.sort((a, b) => b.bytes - a.bytes),
		rules: sum('rules'),
		bytes: sum('bytes'),
		unmatched: sum('unmatched'),
		unmatched_bytes: sum('unmatched_bytes'),
		examples: [...new Set(examples.map((e) => e.sel))].slice(0, 6),
		unscoped: [],
		unreadable
	};
}

/** The build's unscoped-fallback markers in the page's sheets. Inline sheets read their node's
 *  text; linked ones one same-origin fetch each (the HTTP cache answers it). */
export async function scan_unscoped(doc: Document = document): Promise<(UnscopedStyles & { sheet: string })[]> {
	const out: (UnscopedStyles & { sheet: string })[] = [];
	const add = (css: string, sheet: string) => {
		for (const u of find_unscoped(css)) if (!out.some((x) => x.file === u.file)) out.push({ ...u, sheet });
	};
	const jobs: Promise<void>[] = [];
	for (const sheet of Array.from(doc.styleSheets)) {
		const node = sheet.ownerNode as Element | null;
		if (own_sheet(node)) continue;
		if (!sheet.href) {
			if (node?.textContent) add(node.textContent, 'inline <style>');
			continue;
		}
		const href = sheet.href;
		if (new URL(href, location.href).origin !== location.origin) continue;
		jobs.push(
			tool_fetch(href, { cache: 'force-cache' })
				.then((r) => (r.ok ? r.text() : ''))
				.then((css) => add(css, file_of(href)))
				.catch(() => {})
		);
	}
	await Promise.all(jobs);
	return out;
}

export function styles_findings(s: StylesReport): StylesFinding[] {
	const out: StylesFinding[] = [];
	if (s.unscoped.length) {
		const f = unscoped_finding(s.unscoped);
		out.push({ ...f, severity: 'warn' });
	}
	// rules that match nothing: only once checked, and only when it is a real share of real bytes
	if (s.unmatched_bytes >= 20 * 1024 && s.rules && s.unmatched / s.rules >= 0.5) {
		const kb = Math.round(s.unmatched_bytes / 1024);
		const worst = s.sheets.filter((x) => (x.unmatched_bytes ?? 0) > 0).sort((a, b) => (b.unmatched_bytes ?? 0) - (a.unmatched_bytes ?? 0)).slice(0, 3);
		out.push({
			code: 'css-unmatched',
			severity: 'info',
			message: `${Math.floor((s.unmatched / s.rules) * 100)}% of the page's CSS rules (${s.unmatched} of ${s.rules}, about ${kb} KB of rule text) match nothing on it right now. Most in: ${worst.map((w) => `${w.label} ${w.unmatched} rules`).join(', ')}.`,
			fix: 'Styles in a component\'s own <style> load with that component. Move page-specific rules there, or split a big shared sheet by route. Menus, dialogs and content that appears later count as unmatched here: open them and check again.'
		});
	}
	return out;
}
