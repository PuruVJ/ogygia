/**
 * CONTINUITY — ambient island form-field survival across SPA navigation.
 *
 * Leaving a page, every island input whose value differs from its SSR default is snapshotted into a
 * tab-session store, keyed by the page's path + a positional address (nth region + child-index path,
 * the same addressing `interaction` uses, because hydration can replace nodes). Returning to that
 * page, each field is restored when its island (re)hydrates, with `input`/`change` fired so `bind:`
 * syncs. Session-scoped: survives navigation and back/forward, dies with the tab, never persisted.
 *
 * Only DIFFS are stored (default → nothing), bounded page count, so this stays cheap.
 */
import { element_address, resolve_address } from './interaction.js';
import { slots } from './slots.js';

/** Feature entry: enable form-field survival across SPA nav (unless the build disabled it). */
export function install() {
	const on =
		typeof __OGYGIA_CONTINUITY_FORMS__ !== 'undefined' ? __OGYGIA_CONTINUITY_FORMS__ : true;
	if (!on) return;
	slots.forms = { enabled: true, snapshot: snapshot_forms, restore: arm_form_restore };
}

const VALUE_SELECTOR = 'input, textarea, select';
const MAX_PAGES = 20;

type FieldRec = {
	region: number;
	addr: number[];
	tag: string;
	value: string;
	checked: boolean | undefined;
};

/** pathKey → the fields a visitor changed on that page (in this tab session). */
const store = new Map<string, FieldRec[]>();

const is_checkable = (f: HTMLInputElement) => f.type === 'checkbox' || f.type === 'radio';

/** Snapshot changed island fields in `root` under `pathKey`. Call BEFORE the body is swapped out. */
export function snapshot_forms(root: ParentNode, pathKey: string): void {
	const regions = Array.from(root.querySelectorAll('ogygia-region'));
	const recs: FieldRec[] = [];
	regions.forEach((region, ri) => {
		for (const el of region.querySelectorAll(VALUE_SELECTOR)) {
			const f = el as HTMLInputElement;
			// Per-field opt-out: mark a field (or an ancestor) `data-ogygia-no-keep` to never restore
			// it — a fresh-message box, a one-time code, anything that should start blank each visit.
			if (f.closest('[data-ogygia-no-keep]')) continue;
			const changed = is_checkable(f) ? f.checked !== f.defaultChecked : f.value !== f.defaultValue;
			if (!changed) continue;
			const addr = element_address(region, el);
			if (!addr) continue;
			recs.push({
				region: ri,
				addr,
				tag: el.tagName,
				value: f.value,
				checked: is_checkable(f) ? f.checked : undefined
			});
		}
	});
	if (recs.length) {
		store.delete(pathKey); // refresh recency
		store.set(pathKey, recs);
		// Bound the store — evict oldest paths.
		while (store.size > MAX_PAGES) store.delete(store.keys().next().value as string);
	} else {
		store.delete(pathKey);
	}
}

function apply_region(region: Element, ri: number, recs: FieldRec[]): void {
	for (const r of recs) {
		if (r.region !== ri) continue;
		const el = resolve_address(region, r.addr);
		if (!el || el.tagName !== r.tag) continue;
		const f = el as HTMLInputElement;
		let changed = false;
		if (r.checked !== undefined) {
			if (f.checked !== r.checked) {
				f.checked = r.checked;
				changed = true;
			}
		} else if (f.value !== r.value) {
			f.value = r.value;
			changed = true;
		}
		if (changed) {
			f.dispatchEvent(new Event('input', { bubbles: true }));
			f.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}
}

/**
 * Arm restoration for `pathKey` on the freshly-connected page. Restores already-hydrated islands
 * immediately and hooks `ogygia:hydrated` for those still waking. Auto-detaches after a short
 * window (the page's islands have all hydrated by then, or never will).
 */
export function arm_form_restore(pathKey: string): void {
	const recs = store.get(pathKey);
	if (!recs) return;
	const region_list = () => Array.from(document.querySelectorAll('ogygia-region'));

	region_list().forEach((region, ri) => {
		if (region.hasAttribute('data-hydrated')) apply_region(region, ri, recs);
	});

	const on_hydrated = (e: Event) => {
		const region = e.target;
		if (!(region instanceof Element) || region.localName !== 'ogygia-region') return;
		const ri = region_list().indexOf(region);
		if (ri >= 0) apply_region(region, ri, recs);
	};
	document.addEventListener('ogygia:hydrated', on_hydrated, true);
	setTimeout(() => document.removeEventListener('ogygia:hydrated', on_hydrated, true), 5000);
}
