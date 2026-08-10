import { relocate_trailing_empty_comments } from './lake-anchors.js';
import {
	FROZEN_SELECTOR,
	is_frozen,
	region_is_vacant,
	region_max_age_ms,
	region_on_expire,
	region_remount
} from './region-attrs.js';
import { runtime_session } from './session.js';
import { slots, type LakeArm, type LiftedLake } from './slots.js';

/** Feature entry: fill the `lakes` slot so core lifts/restores frozen regions. */
export function install() {
	slots.lakes = {
		on_frozen_connect,
		wait_for_boundary,
		lift,
		restore,
		settle_in,
		mark_frozen_settled,
		after_html_swap,
		after_fetch_exhausted
	};
}

export function settle_in(root: ParentNode) {
	runtime_session.settle_lakes_in(root);
}

export function lift(parent: Element): LiftedLake[] {
	const lifted: LiftedLake[] = [];
	for (const lake of parent.querySelectorAll(FROZEN_SELECTOR)) {
		if (lake.parentElement?.closest('ogygia-region') !== parent) continue;
		const id = lake.getAttribute('entry') || '';
		const frag = document.createDocumentFragment();
		while (lake.firstChild) frag.appendChild(lake.firstChild);
		relocate_trailing_empty_comments(frag, lake);
		lifted.push({
			id,
			frag,
			endpoint: lake.getAttribute('endpoint') || '',
			when: lake.getAttribute('when') || 'load',
			maxAgeMs: region_max_age_ms(lake)
		});
	}
	return lifted;
}

export function restore(parent: Element, lifted: LiftedLake[]) {
	for (const { id, frag, endpoint, when, maxAgeMs } of lifted) {
		const lake = parent.querySelector(`${FROZEN_SELECTOR}[entry="${CSS.escape(id)}"]`);
		if (!lake) continue;
		settle_in(lake);
		settle_in(frag);
		runtime_session.initialized_lakes.add(id);
		lake.appendChild(frag);
		if (endpoint && !lake.getAttribute('endpoint')) lake.setAttribute('endpoint', endpoint);
		const policy = region_remount(lake);
		if ((policy === 'cache' || policy === 'swr') && id && !runtime_session.lake_cache.has(id)) {
			const cached = document.createDocumentFragment();
			for (const child of Array.from(lake.childNodes)) {
				cached.appendChild(child.cloneNode(true));
			}
			runtime_session.set_lake_cache(id, {
				frag: cached,
				endpoint,
				when,
				cachedAt: Date.now(),
				maxAgeMs: maxAgeMs || region_max_age_ms(lake)
			});
		}
	}
}

export function on_frozen_connect(el: HTMLElement, arm: LakeArm): boolean {
	if (!is_frozen(el)) return false;
	const id = el.getAttribute('entry') || '';
	if (!runtime_session.initialized_lakes.has(id)) return true;
	if (!region_is_vacant(el)) return true;
	const policy = region_remount(el);
	switch (policy) {
		case 'empty':
			runtime_session.settled_lakes.add(el);
			return true;
		case 'cache':
		case 'swr': {
			const cached = runtime_session.lake_cache.get(id);
			if (!cached) {
				runtime_session.settled_lakes.add(el);
				return true;
			}
			const max_age = region_max_age_ms(el) || cached.maxAgeMs || 0;
			const expired = max_age > 0 && Date.now() - cached.cachedAt > max_age;
			const on_expire = region_on_expire(el);

			if (expired && on_expire === 'empty') {
				runtime_session.settled_lakes.add(el);
				return true;
			}

			if (expired && on_expire === 'fetch') {
				if (!cached.endpoint) {
					runtime_session.settled_lakes.add(el);
					return true;
				}
				el.setAttribute('endpoint', cached.endpoint);
				const when = el.getAttribute('when') || cached.when || 'load';
				const fire = () => arm.fetch_revalidate();
				if (when === 'idle') arm.idle(fire);
				else if (when === 'visible') arm.visible(fire);
				else if (when === 'load') fire();
				else arm.media(when, fire);
				return true;
			}

			if (policy === 'cache') {
				runtime_session.settled_lakes.add(el);
				el.appendChild(cached.frag.cloneNode(true));
				return true;
			}
			el.appendChild(cached.frag.cloneNode(true));
			if (!cached.endpoint) {
				runtime_session.settled_lakes.add(el);
				arm.wake_children();
				if (import.meta.env.DEV) {
					console.warn(
						`[ogygia] region "${id}" is remount:'swr' but no signed endpoint was captured at SSR — painting the cache only.`
					);
				}
				return true;
			}
			el.setAttribute('endpoint', cached.endpoint);
			const when = el.getAttribute('when') || cached.when || 'load';
			const fire = () => arm.fetch_revalidate();
			if (when === 'idle') arm.idle(fire);
			else if (when === 'visible') arm.visible(fire);
			else if (when === 'load') fire();
			else arm.media(when, fire);
			return true;
		}
		default: {
			const _exhaustive: never = policy;
			return _exhaustive;
		}
	}
}

export function wait_for_boundary(_el: HTMLElement, boundary: Element | null): boolean {
	return !!(boundary && is_frozen(boundary) && !runtime_session.settled_lakes.has(boundary));
}

export function mark_frozen_settled(region: HTMLElement) {
	if (is_frozen(region)) runtime_session.settled_lakes.add(region);
}

export function after_html_swap(region: HTMLElement, opts: { revalidate?: boolean }) {
	if (!(opts.revalidate && is_frozen(region))) return;
	const id = region.getAttribute('entry') || '';
	if (!id) return;
	const cached = document.createDocumentFragment();
	for (const child of Array.from(region.childNodes)) {
		cached.appendChild(child.cloneNode(true));
	}
	const prev = runtime_session.lake_cache.get(id);
	runtime_session.set_lake_cache(id, {
		frag: cached,
		endpoint: region.getAttribute('endpoint') || prev?.endpoint || '',
		when: region.getAttribute('when') || prev?.when || 'load',
		cachedAt: Date.now(),
		maxAgeMs: region_max_age_ms(region) || prev?.maxAgeMs || 0
	});
}

export function after_fetch_exhausted(
	region: HTMLElement,
	opts: { revalidate?: boolean },
	wake_children: () => void
) {
	if (opts.revalidate && is_frozen(region) && region.isConnected) {
		runtime_session.settled_lakes.add(region);
		wake_children();
	}
}
