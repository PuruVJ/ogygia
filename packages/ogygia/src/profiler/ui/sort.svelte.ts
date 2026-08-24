/**
 * Reactive column sort shared by the profiler's tables (was report.ts's TABLE_SORT_JS DOM hack).
 * Give it a getter for the rows and the initial numeric key; it owns the sort state and returns the
 * sorted view + a click handler. Svelte runes in a `.svelte.ts` module — imported by the table
 * islands, one instance each.
 */
export function sortable<T extends Record<string, unknown>>(rows: () => T[], initial_key: string) {
	let key = $state(initial_key);
	let dir = $state<'asc' | 'desc'>('desc');

	const sorted = $derived(
		[...rows()].sort((a, b) => {
			const x = Number(a[key]) || 0;
			const y = Number(b[key]) || 0;
			return dir === 'asc' ? x - y : y - x;
		})
	);

	function click(k: string) {
		if (key === k) dir = dir === 'asc' ? 'desc' : 'asc';
		else {
			key = k;
			dir = 'desc';
		}
	}

	/** The little arrow for a header: ▲/▼ when it's the active column, else empty. */
	function arrow(k: string) {
		return key === k ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
	}

	return {
		get key() {
			return key;
		},
		get sorted() {
			return sorted;
		},
		click,
		arrow
	};
}
