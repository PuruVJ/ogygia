/**
 * WHAT DRAWS DIFFERENTLY IN THE BROWSER: the lines of a `.svelte` component that make its first
 * browser render differ from the server's — the cause a hydration mismatch (Svelte threw the server
 * DOM away) or a markup change on wake most often has, named by line:
 *
 * - `await`: an `await` at the top level of the instance script (an async component: the browser
 *   awaits again, and another answer — or a fetch the browser cannot make — draws another tree);
 * - `browser`: a value only the browser has, read while rendering — `typeof window`, `window.` /
 *   `document.` / `navigator.` / `localStorage` / `sessionStorage`, `Date.now()`, `new Date()`,
 *   `Math.random()`, `matchMedia(` — in the markup, or at the top level of the script (a `$derived`,
 *   a `const`), never inside a function, an effect or an event handler (those run after the wake).
 *
 * String scanning, line by line (no regex, no parser): brace depth tells the top level of the
 * script; a markup line's handler attributes (`onclick={…}`) are left out.
 */

export interface Hazard {
	line: number;
	/** the line, trimmed */
	code: string;
	kind: 'await' | 'browser';
	/** what it reads (`window.location`, `Date.now()`), for `browser` */
	reads?: string;
	/** an `if (…)` at the script's top level: a guard around browser-only work, which may draw the
	 *  same markup both sides — a lead for a mismatch seen, not a prediction of one */
	guard?: true;
}

/** a hazard with the file it is in (the profiler's island chunks, the dev server's module graph) */
export type IslandHazard = Hazard & { file: string };

/** "In its own code, the likeliest: X.svelte:4 (`…`) awaits …; Y.svelte:8 reads Date.now( while rendering …" —
 *  said the same by the profiler's report and the devtools' Page tab */
export function hazard_words(lines: readonly IslandHazard[]): string {
	const one = (h: IslandHazard) => {
		const code = h.code.length > 70 ? h.code.slice(0, 69) + '…' : h.code;
		const where = `${h.file.split('/').pop()}:${h.line} (\`${code}\`)`;
		return h.kind === 'await' ? `${where} awaits at the top of its script: the browser runs it again, and another answer draws another tree` : `${where} reads ${h.reads ?? 'a browser-only value'} while rendering, a value the server does not have`;
	};
	return `In its own code, the likeliest: ${lines.slice(0, 2).map(one).join('; ')}.`;
}

/** The fix for those lines: what to do with each kind. */
export function hazard_fix(lines: readonly IslandHazard[]): string {
	const kinds = new Set(lines.map((h) => h.kind));
	return [
		...(kinds.has('await') ? ['Give both sides the same answer: pass the data in from the server (a load, a prop) rather than awaiting it again in the browser.'] : []),
		...(kinds.has('browser') ? ["Read the browser-only value after the wake (in `$effect` or `onMount`), or take it from what both sides have (the page's URL from `$app/state`, a time passed in as a prop)."] : [])
	].join(' ');
}

const BROWSER_READS =['typeof window', 'window.', 'document.', 'navigator.', 'localStorage', 'sessionStorage', 'Date.now(', 'new Date()', 'Math.random(', 'matchMedia('];

const is_ident = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/** The first browser-only read on a stretch of code, or undefined. */
function browser_read(code: string): string | undefined {
	for (const r of BROWSER_READS) {
		const at = code.indexOf(r);
		if (at === -1) continue;
		// (a word, not part of one: `mywindow.`, `subdocument.`)
		if (at > 0 && is_ident(code.charCodeAt(at - 1))) continue;
		if (r === 'typeof window' || r.endsWith('(') || r === 'localStorage' || r === 'sessionStorage') return r;
		// `window.location`: the member read, up to the next non-name character
		let end = at + r.length;
		while (end < code.length && is_ident(code.charCodeAt(end))) end++;
		return code.slice(at, end);
	}
	return undefined;
}

/** A markup line without its event-handler attributes (`onclick={() => window.scrollTo(0, 0)}`). */
function without_handlers(line: string): string {
	let out = '';
	let i = 0;
	while (i < line.length) {
		// ` on<word>={` … the matching `}`
		const at = line.indexOf('on', i);
		if (at === -1) break;
		const prev = at > 0 ? line[at - 1] : ' ';
		let j = at + 2;
		while (j < line.length && ((line[j] >= 'a' && line[j] <= 'z') || line[j] === ':')) j++;
		if ((prev === ' ' || prev === '\t') && j > at + 2 && line[j] === '=' && line[j + 1] === '{') {
			out += line.slice(i, at);
			let depth = 0;
			let k = j + 1;
			for (; k < line.length; k++) {
				if (line[k] === '{') depth++;
				else if (line[k] === '}' && --depth === 0) break;
			}
			i = k + 1;
			continue;
		}
		out += line.slice(i, at + 2);
		i = at + 2;
	}
	return out + line.slice(i);
}

export function hydration_hazards(source: string): Hazard[] {
	const out: Hazard[] = [];
	const lines = source.split('\n');
	let in_script = false;
	let module_script = false;
	let in_style = false;
	let depth = 0;
	// the script's callbacks: `onMount(`, `$effect(`, `function`, arrows — what runs after the wake
	let deferred_depth = -1;
	let arrow_body = false;
	for (let n = 0; n < lines.length; n++) {
		const raw = lines[n];
		const line = raw.trim();
		if (!in_script && !in_style && line.startsWith('<script')) {
			in_script = !line.includes('</script>');
			module_script = line.includes('module');
			depth = 0;
			deferred_depth = -1;
			continue;
		}
		if (in_script && line.startsWith('</script')) {
			in_script = false;
			continue;
		}
		if (!in_script && line.startsWith('<style')) {
			in_style = !line.includes('</style>');
			continue;
		}
		if (in_style) {
			if (line.startsWith('</style')) in_style = false;
			continue;
		}
		if (in_script) {
			// (a module script runs once per server process and once in the browser: not a render)
			// (an arrow whose body is on the next lines, no braces: `const reduced = () =>` ⏎ `matchMedia(…)`
			// — the body runs when it is called, until the statement ends)
			const in_arrow_body = arrow_body;
			if (arrow_body && (line.endsWith(';') || line === '')) arrow_body = false;
			if (!in_arrow_body && line.endsWith('=>')) arrow_body = true;
			const top = depth === 0 && deferred_depth === -1 && !module_script && !in_arrow_body;
			if (top && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*')) {
				const aw = line.indexOf('await ');
				if (aw !== -1 && (aw === 0 || !is_ident(line.charCodeAt(aw - 1)))) out.push({ line: n + 1, code: line, kind: 'await' });
				else if (!line.startsWith('import ') && !line.startsWith('function ') && !line.startsWith('export function ')) {
					const reads = browser_read(line);
					if (reads) out.push({ line: n + 1, code: line, kind: 'browser', reads, ...(line.startsWith('if (') || line.startsWith('if(') ? { guard: true as const } : {}) });
				}
			}
			// a callback opening on this line (onMount, $effect, function, an arrow): its body runs later
			if (deferred_depth === -1 && (line.includes('onMount(') || line.includes('$effect(') || line.includes('function') || line.includes('=>')) && !line.startsWith('const ') && !line.startsWith('let ')) deferred_depth = depth;
			else if (deferred_depth === -1 && (line.startsWith('const ') || line.startsWith('let ')) && line.includes('=>') && line.includes('{')) deferred_depth = depth;
			for (const ch of line) {
				if (ch === '{') depth++;
				else if (ch === '}') depth--;
			}
			if (deferred_depth !== -1 && depth <= deferred_depth) deferred_depth = -1;
			continue;
		}
		// the markup: `{…}` expressions render; handler attributes run on events
		if (!line.includes('{')) continue;
		const reads = browser_read(without_handlers(line));
		if (reads) out.push({ line: n + 1, code: line, kind: 'browser', reads });
	}
	return out;
}
