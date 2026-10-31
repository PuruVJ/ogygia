/**
 * PRESSABLE — the report's clickable rows, sort headers, timeline blocks and legend keys, for the
 * keyboard: Tab reaches the element, Enter or Space presses it (its own click handler runs, so
 * there is one code path). A table row or header cannot hold a button without changing the
 * table's shape; this keeps the markup and adds the keys.
 */
import type { Attachment } from 'svelte/attachments';

/** The keys alone, as an `onkeydown` handler: for an element whose markup already gives it its
 *  role and `tabindex="0"`, so the compiler sees the keyboard path next to the click. */
export const press_key = (e: Event): void => {
	const node = e.currentTarget as HTMLElement | SVGElement;
	const k = (e as KeyboardEvent).key;
	// a key pressed in a field inside (a filter in a row) is that field's
	if (e.target !== node || (k !== 'Enter' && k !== ' ')) return;
	e.preventDefault();
	node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

export const pressable: Attachment<HTMLElement | SVGElement> = (node) => {
	if (node.tabIndex < 0) node.tabIndex = 0;
	node.addEventListener('keydown', press_key);
	return () => node.removeEventListener('keydown', press_key);
};
