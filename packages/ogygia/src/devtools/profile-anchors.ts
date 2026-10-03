/**
 * THE PROFILE, POINTED AT THE PAGE: each server-side cost the profiler measured that has a place on
 * this page, with the elements it lives in — so the dock can light them up. What maps:
 *  - a component (by file): every element it rendered in the browser (Svelte's dev build marks each
 *    element it creates with its source location — so the islands' parts, on the dev server);
 *  - a span split by element tag (`span('x', …, { tag })`): the elements of that tag;
 *  - the declarative shadow roots the document carries (a design system's server render): their hosts;
 *  - the largest paint: the island it sat in;
 *  - an island row: the island.
 * A cost with nothing on the page is left out. The element lookups are one pass over the page, cached
 * per profile and invalidated by the caller (the tick).
 */
import type { SlimProfile } from './profile-store.js';

export interface Anchor {
	key: string;
	title: string;
	detail: string;
	/** the elements, found now */
	find: () => Element[];
	/** how many there were when the list was built */
	count: number;
}

const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n >= 10 ? Math.round(n) + ' ms' : n.toFixed(1) + ' ms');
const kb = (n: number) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');

/** a tag name we may put in a selector: letters, digits and dashes, starting with a letter */
export function safe_tag(t: string): boolean {
	if (!t || t.length > 60) return false;
	const c0 = t.charCodeAt(0);
	if (!((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90))) return false;
	for (let i = 1; i < t.length; i++) {
		const c = t.charCodeAt(i);
		if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45)) return false;
	}
	return true;
}

/** Every element on the page, INTO open shadow roots (a design system nests its parts in them), the
 *  dock's own host left out. */
export function all_elements(doc: Document = document): Element[] {
	const out: Element[] = [];
	const walk = (root: Document | ShadowRoot) => {
		for (const el of root.querySelectorAll('*')) {
			if (el.hasAttribute('data-ogygia-devtools-host')) continue;
			out.push(el);
			if (el.shadowRoot) walk(el.shadowRoot);
		}
	};
	walk(doc);
	return out;
}

/** Every element that has a source location, by file (one pass over the page). */
export function elements_by_file(doc: Document = document): Map<string, Element[]> {
	const out = new Map<string, Element[]>();
	for (const el of all_elements(doc)) {
		const file = (el as { __svelte_meta?: { loc?: { file?: string } } }).__svelte_meta?.loc?.file;
		if (!file) continue;
		const list = out.get(file);
		if (list) list.push(el);
		else out.set(file, [el]);
	}
	return out;
}

/** Hosts of declarative shadow roots on the page (the dock's own host left out). */
export function shadow_hosts(doc: Document = document): Element[] {
	return all_elements(doc).filter((el) => !!el.shadowRoot);
}

/** Elements of a tag, into shadow roots. */
export function by_tag(tag: string, doc: Document = document): Element[] {
	const t = tag.toLowerCase();
	return all_elements(doc).filter((el) => el.localName === t);
}

const same_file = (a: string, b: string) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);

export function page_anchors(p: SlimProfile, doc: Document = document): Anchor[] {
	const out: Anchor[] = [];
	const by_file = elements_by_file(doc);
	const files = [...by_file.keys()];
	const els_of = (file: string) => {
		const hit = files.find((f) => same_file(f, file));
		return hit ? (by_file.get(hit) ?? []) : [];
	};

	// the heaviest components with a place on the page — one per file: an island's host row and its
	// component's own row ("Counter (island host)", "Counter") share the file and its elements (two
	// with one key broke the dock's list: each_key_duplicate, the run never drew)
	const seen_files = new Set<string>();
	for (const c of p.components) {
		if (!c.file || !c.file.endsWith('.svelte') || seen_files.has(c.file)) continue;
		seen_files.add(c.file);
		const n = els_of(c.file).length;
		if (!n) continue;
		const file = c.file;
		out.push({
			key: 'component:' + file,
			title: c.name,
			detail: `${ms(c.self_ms)} on the server${c.instances ? ` for ${c.instances} instance${c.instances === 1 ? '' : 's'}` : ''} · ${n} element${n === 1 ? '' : 's'} here`,
			find: () => els_of(file),
			count: n
		});
		if (out.length >= 6) break;
	}

	// the heaviest islands (server render, then props): where each one sits
	const islands = p.islands
		.filter((i) => i.fp && doc.querySelector(`ogygia-region[data-og-fp="${i.fp}"]`))
		.sort((a, b) => (b.ssr_ms ?? 0) - (a.ssr_ms ?? 0) || (b.props_bytes ?? 0) - (a.props_bytes ?? 0))
		.slice(0, 4);
	for (const i of islands) {
		const fp = i.fp!;
		out.push({
			key: 'island:' + fp,
			title: `${i.name} (island)`,
			detail: [
				i.ssr_ms !== null ? `${ms(i.ssr_ms)} server render` : null,
				i.props_bytes !== null ? `${kb(i.props_bytes)} props${i.culprit ? ` (not JSON: ${i.culprit})` : ''}` : null,
				i.client_p50_ms !== null ? `${ms(i.client_p50_ms)} to hydrate` : null
			]
				.filter(Boolean)
				.join(' · '),
			find: () => [...doc.querySelectorAll(`ogygia-region[data-og-fp="${fp}"]`)],
			count: 1
		});
	}

	// spans split by element tag (per render: the profile's counts cover every run)
	const runs = Math.max(1, p.runs.length);
	for (const s of p.spans) {
		for (const t of s.tags) {
			if (!safe_tag(t.tag)) continue;
			const n = by_tag(t.tag, doc).length;
			if (!n) continue;
			const tag = t.tag;
			out.push({
				key: `span:${s.name}:${tag}`,
				title: `${s.name} · <${tag}>`,
				detail: `${Math.round(t.count / runs)} per render, ${ms(t.ms / runs)} of the server's CPU each render · ${n} on the page`,
				find: () => by_tag(tag, doc),
				count: n
			});
		}
	}

	// the declarative shadow roots the server wrote
	if (p.html && p.html.shadow_count) {
		const n = shadow_hosts(doc).length;
		if (n)
			out.push({
				key: 'html:shadow',
				title: `${p.html.shadow_count} declarative shadow roots`,
				detail:
					`${kb(p.html.shadow)} of the ${kb(p.html.total)} HTML · ${n} became shadow roots here` +
					(n < p.html.shadow_count
						? ` — the browser refused the other ${p.html.shadow_count - n} (a second shadow root on one element is not allowed): their bytes are shipped for nothing`
						: ''),
				find: () => shadow_hosts(doc),
				count: n
			});
	}

	// the largest paint
	if (p.lcp && (p.lcp.fp || p.lcp.tag)) {
		const find = () => {
			const island = p.lcp!.fp ? doc.querySelector(`ogygia-region[data-og-fp="${p.lcp!.fp}"]`) : null;
			if (island && p.lcp!.tag && safe_tag(p.lcp!.tag)) {
				const inner = island.querySelector(p.lcp!.tag);
				if (inner) return [inner];
			}
			return island ? [island] : [];
		};
		const n = find().length;
		if (n)
			out.push({
				key: 'lcp',
				title: 'Largest paint',
				detail: `<${p.lcp.tag ?? '?'}>${p.lcp.ms !== null ? ` at ${ms(p.lcp.ms)}` : ''}${p.lcp.fp ? ` in ${p.islands.find((i) => i.fp === p.lcp!.fp)?.name ?? 'an island'}` : ''}`,
				find,
				count: n
			});
	}
	// (each key once: the dock keys its list by it — two spans of one name and tag would collide too)
	const keys = new Set<string>();
	return out.filter((a) => !keys.has(a.key) && !!keys.add(a.key));
}
