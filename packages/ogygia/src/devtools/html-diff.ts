/**
 * A readable diff of two HTML strings — the server's markup and what the browser ended up with —
 * for the Hydration tab. HTML is cut into tokens (a tag, or the text between tags; comments dropped,
 * whitespace runs folded), the token lists are diffed (Myers, O(ND)), and the result is grouped into
 * hunks with a little context. No regex. A diff too large to compute (edit distance past `max_d`)
 * falls back to the first difference.
 */

export type DiffOp = { op: 'same' | 'del' | 'add'; text: string };
export interface DiffHunk {
	ops: DiffOp[];
}
export interface HtmlDiff {
	hunks: DiffHunk[];
	/** tokens removed / added */
	removed: number;
	added: number;
	/** the diff gave up (too many changes) and shows only where they start */
	partial: boolean;
}

/** Tags and text runs; comments out; whitespace inside text folded to one space. */
export function tokenize(html: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < html.length) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html[i] === '<') {
			const end = html.indexOf('>', i);
			const stop = end === -1 ? html.length : end + 1;
			out.push(html.slice(i, stop));
			i = stop;
			continue;
		}
		const next = html.indexOf('<', i);
		const stop = next === -1 ? html.length : next;
		let text = '';
		let space = false;
		for (let k = i; k < stop; k++) {
			const c = html.charCodeAt(k);
			if (c === 32 || c === 9 || c === 10 || c === 13) space = true;
			else {
				if (space && text) text += ' ';
				space = false;
				text += html[k];
			}
		}
		if (text) out.push(text);
		i = stop;
	}
	return out;
}

/** Myers diff over token arrays; null when the edit distance passes `max_d`. */
function myers(a: string[], b: string[], max_d: number): DiffOp[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, max_d);
	const off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) {
				// walk back
				const ops: DiffOp[] = [];
				let cx = n;
				let cy = m;
				for (let dd = d; dd > 0; dd--) {
					const pv = trace[dd];
					const kk = cx - cy;
					const prev_k = kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1]) ? kk + 1 : kk - 1;
					const px = pv[off + prev_k];
					const py = px - prev_k;
					while (cx > px && cy > py) ops.push({ op: 'same', text: a[--cx] }), cy--;
					if (cx === px) ops.push({ op: 'add', text: b[--cy] });
					else ops.push({ op: 'del', text: a[--cx] });
				}
				while (cx > 0 && cy > 0) ops.push({ op: 'same', text: a[--cx] }), cy--;
				return ops.reverse();
			}
		}
	}
	return null;
}

export function html_diff(server: string, browser: string, context = 3, max_d = 800): HtmlDiff {
	const a = tokenize(server);
	const b = tokenize(browser);
	// the shared head and tail first: the diff only sees the middle
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const mid_a = a.slice(head, a.length - tail);
	const mid_b = b.slice(head, b.length - tail);
	let ops = myers(mid_a, mid_b, max_d);
	let partial = false;
	if (!ops) {
		partial = true;
		ops = [...mid_a.slice(0, 20).map((text) => ({ op: 'del' as const, text })), ...mid_b.slice(0, 20).map((text) => ({ op: 'add' as const, text }))];
	}
	const all: DiffOp[] = [...a.slice(Math.max(0, head - context), head).map((text) => ({ op: 'same' as const, text })), ...ops, ...a.slice(a.length - tail, a.length - tail + context).map((text) => ({ op: 'same' as const, text }))];
	// hunks: runs of changes with `context` same-tokens around them
	const hunks: DiffHunk[] = [];
	let cur: DiffOp[] | null = null;
	let same_run = 0;
	for (let i = 0; i < all.length; i++) {
		const o = all[i];
		if (o.op === 'same') {
			if (cur) {
				same_run++;
				if (same_run <= context) cur.push(o);
				else {
					hunks.push({ ops: cur });
					cur = null;
				}
			}
			continue;
		}
		if (!cur) {
			cur = [];
			for (let k = Math.max(0, i - context); k < i; k++) if (all[k].op === 'same') cur.push(all[k]);
		}
		same_run = 0;
		cur.push(o);
	}
	if (cur) hunks.push({ ops: cur });
	return {
		hunks: hunks.slice(0, 20),
		removed: ops.filter((o) => o.op === 'del').length,
		added: ops.filter((o) => o.op === 'add').length,
		partial
	};
}
