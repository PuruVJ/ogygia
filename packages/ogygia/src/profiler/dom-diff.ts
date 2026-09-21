/**
 * DOM TIME TRAVEL — an island's markup at three moments (as the server sent it, after it hydrated,
 * when the page went away) and what changed between them, plus the layout shifts of a visit
 * drawn as boxes. Pure: `html_diff` is a token diff (tags and text runs) with a size cap so a huge
 * island never freezes the report; `shift_boxes` normalizes shift rectangles to the viewport.
 */

export interface DiffOp {
	kind: 'same' | 'add' | 'del';
	text: string;
}

export interface HtmlDiff {
	ops: DiffOp[];
	added: number;
	removed: number;
	/** the middle was too large to diff token by token and is shown as one removal + one addition */
	truncated: boolean;
	/** the tokens both sides share, as a share of the longer side (1 = identical) */
	same_ratio: number;
}

const TOKEN_RE = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g;

export function tokenize_html(s: string): string[] {
	const out: string[] = [];
	let m: RegExpExecArray | null;
	TOKEN_RE.lastIndex = 0;
	while ((m = TOKEN_RE.exec(s))) {
		const t = m[0];
		// split long text runs on whitespace so a one-word change is one token
		if (t[0] !== '<' && t.length > 40) out.push(...t.split(/(\s+)/).filter(Boolean));
		else out.push(t);
	}
	return out;
}

const MAX_CELLS = 2_000_000;

export function html_diff(a: string, b: string): HtmlDiff {
	if (a === b) return { ops: [{ kind: 'same', text: a }], added: 0, removed: 0, truncated: false, same_ratio: 1 };
	const A = tokenize_html(a);
	const B = tokenize_html(b);
	// common prefix / suffix
	let p = 0;
	while (p < A.length && p < B.length && A[p] === B[p]) p++;
	let s = 0;
	while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
	const midA = A.slice(p, A.length - s);
	const midB = B.slice(p, B.length - s);
	const ops: DiffOp[] = [];
	if (p) ops.push({ kind: 'same', text: A.slice(0, p).join('') });
	let truncated = false;
	let same_mid = 0;
	if (midA.length * midB.length > MAX_CELLS) {
		truncated = true;
		if (midA.length) ops.push({ kind: 'del', text: midA.join('') });
		if (midB.length) ops.push({ kind: 'add', text: midB.join('') });
	} else if (midA.length || midB.length) {
		// LCS table over the middle
		const n = midA.length;
		const m = midB.length;
		const L = new Uint32Array((n + 1) * (m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				L[i * (m + 1) + j] = midA[i] === midB[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		const push = (kind: DiffOp['kind'], text: string) => {
			const last = ops[ops.length - 1];
			if (last && last.kind === kind) last.text += text;
			else ops.push({ kind, text });
		};
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				push('same', midA[i]);
				same_mid++;
				i++;
				j++;
			} else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) push('del', midA[i++]);
			else push('add', midB[j++]);
		}
		while (i < n) push('del', midA[i++]);
		while (j < m) push('add', midB[j++]);
	}
	if (s) {
		const tail = A.slice(A.length - s).join('');
		const last = ops[ops.length - 1];
		if (last && last.kind === 'same') last.text += tail;
		else ops.push({ kind: 'same', text: tail });
	}
	const added = ops.filter((o) => o.kind === 'add').reduce((x, o) => x + o.text.length, 0);
	const removed = ops.filter((o) => o.kind === 'del').reduce((x, o) => x + o.text.length, 0);
	const longer = Math.max(A.length, B.length) || 1;
	return { ops, added, removed, truncated, same_ratio: Math.round(((p + s + same_mid) / longer) * 1000) / 1000 };
}

export interface ShiftBox {
	/** 0..1 of the viewport */
	x: number;
	y: number;
	w: number;
	h: number;
	/** where it came from, same units */
	fx: number;
	fy: number;
	value: number;
	t: number;
	fp?: string;
}

/** Layout-shift rectangles normalized to the viewport, biggest shift first; boxes outside the
 *  viewport are clipped, a missing rect is skipped. */
export function shift_boxes(shifts: { t: number; value: number; fp?: string; from?: [number, number, number, number]; to?: [number, number, number, number] }[], viewport: [number, number] | undefined): ShiftBox[] {
	const [vw, vh] = viewport ?? [1, 1];
	if (!(vw > 0 && vh > 0)) return [];
	const clamp = (n: number) => Math.max(0, Math.min(1, n));
	const out: ShiftBox[] = [];
	for (const s of shifts) {
		const to = s.to ?? s.from;
		if (!to) continue;
		const from = s.from ?? to;
		out.push({ x: clamp(to[0] / vw), y: clamp(to[1] / vh), w: clamp(to[2] / vw), h: clamp(to[3] / vh), fx: clamp(from[0] / vw), fy: clamp(from[1] / vh), value: s.value, t: s.t, ...(s.fp ? { fp: s.fp } : {}) });
	}
	return out.sort((a, b) => b.value - a.value);
}
