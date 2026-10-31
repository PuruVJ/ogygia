/**
 * A component's source with every `<style>` block's CONTENT blanked: each character a space,
 * newlines kept, so every offset is the source's own (edits made from the parse land on the
 * original, and a `source.slice(ast.css.start, ast.css.end)` still reads the real style).
 *
 * For the passes that parse a RAW component (before any preprocessor) and never read its styles:
 * Svelte's parser reads `<style>` as plain CSS, and a valid `<style lang="scss">` with SCSS-only
 * syntax (`#{$i}`, `@each`, `@for`) throws `css_expected_identifier`. Those passes then skipped the
 * file in silence: the barrel rewrite left its imports on their barrels (the island shipped the
 * whole barrel), the island transform left its region imports untransformed.
 *
 * A `<style>` inside a `<script>` (a template string) is script text and is left alone. String
 * scanning, no regex: it runs over every component.
 */

/** Where the closing `</tag` is from `from`, or -1. Case-insensitive. */
function close_of(code: string, tag: string, from: number): number {
	const close = `</${tag}`;
	for (let i = code.indexOf('</', from); i !== -1; i = code.indexOf('</', i + 2)) {
		if (code.slice(i, i + close.length).toLowerCase() === close) return i;
	}
	return -1;
}

/** At `i`, an opening `<tag` (followed by whitespace, `>` or `/`)? */
function opens(code: string, i: number, tag: string): boolean {
	if (code.slice(i + 1, i + 1 + tag.length).toLowerCase() !== tag) return false;
	const c = code[i + 1 + tag.length];
	return c === '>' || c === '/' || c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

export function blank_styles(code: string): string {
	if (!code.includes('<style') && !code.includes('<STYLE')) return code;
	let out = '';
	let at = 0;
	let i = code.indexOf('<');
	while (i !== -1) {
		if (opens(code, i, 'script')) {
			// a script's text is its own until `</script`: skip it whole
			const gt = code.indexOf('>', i);
			const close = gt === -1 ? -1 : close_of(code, 'script', gt + 1);
			if (close === -1) break;
			i = code.indexOf('<', close + 2);
			continue;
		}
		if (opens(code, i, 'style')) {
			const gt = code.indexOf('>', i);
			const close = gt === -1 ? -1 : close_of(code, 'style', gt + 1);
			if (close === -1) break;
			out += code.slice(at, gt + 1);
			let run = 0;
			for (let k = gt + 1; k < close; k++) {
				const c = code[k];
				if (c === '\n' || c === '\r') {
					out += ' '.repeat(run) + c;
					run = 0;
				} else run++;
			}
			out += ' '.repeat(run);
			at = close;
			i = code.indexOf('<', close + 2);
			continue;
		}
		i = code.indexOf('<', i + 1);
	}
	return at === 0 ? code : out + code.slice(at);
}
