/**
 * The comment an unscoped CSS fallback carries in the shipped stylesheet. When the build cannot
 * compile a component's scoped CSS (compiler/fouc-css.ts), it ships the raw style bodies, which
 * then apply to the WHOLE page (`.bar {…}` instead of `.bar.svelte-x {…}`). A build log line is
 * easy to miss, so the CSS itself says so, and devtools (the page's sheets) and the profiler (the
 * weighed CSS files) name the component. Import-free: the browser loads this too.
 *
 * A legal comment (`/*!`) so a minifier keeps it; the file NAME only, never the build machine's path.
 */
export const UNSCOPED_MARK = 'ogygia-unscoped:';

export function unscoped_marker(abs: string, why: string): string {
	const name = abs.slice(Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')) + 1);
	const safe = (s: string) => s.split('*/').join('* /').split('\n').join(' ').slice(0, 160);
	return `/*! ${UNSCOPED_MARK} ${safe(name)} | ${safe(why)} */\n`;
}

export interface UnscopedStyles {
	/** the component's file name (`Card.svelte`) */
	file: string;
	/** why the build could not scope it (the compiler's first message line) */
	why: string;
}

/** The finding both devtools and the profiler raise, in the same words. */
export function unscoped_finding(list: readonly UnscopedStyles[]): { code: 'css-unscoped'; message: string; fix: string } {
	const names = list.slice(0, 4).map((u) => (u.why ? `${u.file} (${u.why})` : u.file));
	const one = list.length === 1;
	return {
		code: 'css-unscoped',
		message:
			`${names.join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}: ${one ? 'its' : 'their'} styles shipped without the component's scope, so every rule in them applies to the whole page. ` +
			`A \`.row\` or \`.bar\` in ${one ? 'it' : 'them'} restyles any element with that class, in any component. The build could not compile ${one ? 'it' : 'them'} and fell back to the raw style ${one ? 'body' : 'bodies'}.`,
		fix: `The build log has a line "scoped CSS for … could not be compiled" with the full reason. Usually a style language the build cannot read here (scss and sass are compiled; less and stylus are not) or markup the compiler rejects. Fix that and rebuild.`
	};
}

/** Every unscoped fallback a stylesheet's text carries, once per file. Plain scan, no regex: it
 *  runs over whole stylesheets in the browser. */
export function find_unscoped(css: string): UnscopedStyles[] {
	const out: UnscopedStyles[] = [];
	const seen = new Set<string>();
	let at = css.indexOf(UNSCOPED_MARK);
	while (at !== -1) {
		const end = css.indexOf('*/', at);
		if (end === -1) break;
		const body = css.slice(at + UNSCOPED_MARK.length, end).trim();
		const bar = body.indexOf(' | ');
		const u = bar === -1 ? { file: body, why: '' } : { file: body.slice(0, bar), why: body.slice(bar + 3).trim() };
		if (!seen.has(u.file)) {
			seen.add(u.file);
			out.push(u);
		}
		at = css.indexOf(UNSCOPED_MARK, end);
	}
	return out;
}
