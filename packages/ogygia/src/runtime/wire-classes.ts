/**
 * THE TRANSPORTABLE CLASSES AN ISLAND NEEDS, loaded before it decodes its props. An `[ogygia.wire]`
 * class revives through its registered codec, and its module registers it when it loads. Every island
 * page used to load every transportable class of the app up front (each island entry imported them
 * all); now the client build carries only a map of lazy loaders (`virtual:ogygia/transportables`), and
 * an island loads just what it carries:
 * - its props: the server stamped the classes on the props sidecar (`data-og-wire`, tag paths);
 * - the context it reads: the `<ogygia-provide>` payloads around it and the page's context root;
 * - the page's seeds (`page.data`, the remote-query seed), checked once per document.
 * The small texts are checked for each class's tag path (`"<path>#`). An app that sends wired values
 * through Kit's `transport` (`wire_all`: remote functions, loads) gets every class with every island,
 * as before: those values decode synchronously whenever they arrive. Each module loads once.
 */
import { wire_loaders, wire_all } from 'virtual:ogygia/transportables';
import { props_sidecar_of } from './sidecar.js';

const loaders = wire_loaders as Record<string, () => Promise<unknown>>;
const paths = Object.keys(loaders);
const loading = new Map<string, Promise<unknown>>();

function load(path: string): Promise<unknown> {
	let p = loading.get(path);
	if (!p) {
		const loader = loaders[path];
		// (a failed load resolves: the decode then says which class is missing, as it always did)
		p = loader ? loader().catch(() => undefined) : Promise.resolve();
		loading.set(path, p);
	}
	return p;
}

/** The classes a text names (`"<tag path>#…` appears in it), into `want`. */
function scan(text: string | null | undefined, want: Set<string>): void {
	if (!text) return;
	for (const p of paths) if (!want.has(p) && text.indexOf('"' + p + '#') !== -1) want.add(p);
}

/** The document's seeds, checked once per document (a router swap brings new ones). */
let seed_classes: { doc: Document; want: Set<string> } | null = null;
function classes_in_seeds(doc: Document): Set<string> {
	if (seed_classes?.doc === doc) return seed_classes.want;
	const want = new Set<string>();
	for (const s of doc.querySelectorAll('script[type="application/ogygia-page"], script[type="application/ogygia-remote"]')) scan(s.textContent, want);
	seed_classes = { doc, want };
	return want;
}
if (typeof document !== 'undefined') document.addEventListener('og:after-swap', () => (seed_classes = null));

/** The loads this island's props, context and page seeds need, or `null` when none (the common
 *  case: an app without transportables, or an island that carries none). */
export function wire_classes_for(region: Element): Promise<unknown> | null {
	if (!paths.length) return null;
	const want = new Set<string>();
	if (wire_all) for (const p of paths) want.add(p);
	else {
		const stamp = props_sidecar_of(region)?.getAttribute('data-og-wire');
		if (stamp) for (const p of stamp.split(' ')) if (p) want.add(p);
		for (let el = region.parentElement; el; el = el.parentElement)
			if (el.tagName === 'OGYGIA-PROVIDE') scan(el.querySelector(':scope > script[data-ogygia-provide]')?.textContent, want);
		const doc = region.ownerDocument;
		scan(doc.querySelector('script[data-ogygia-provide-page]')?.textContent, want);
		for (const p of classes_in_seeds(doc)) want.add(p);
	}
	if (!want.size) return null;
	const pending: Promise<unknown>[] = [];
	for (const p of want) pending.push(load(p));
	return Promise.all(pending);
}
