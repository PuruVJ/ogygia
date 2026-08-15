/**
 * Strip the common leading indentation from a block of source, and trim leading/trailing blank
 * lines. Source embedded in a call (`import.meta.og.code(\`…\`, …)`) is indented to match where the
 * call sits; that indentation is an artifact of the surrounding code, not part of the snippet. This
 * normalizes it so the rendered `<pre>` shows the snippet's OWN logical indentation, flush-left.
 *
 * Blank lines (whitespace-only) don't count toward the common indent; tabs and spaces are treated by
 * their literal column contribution to the prefix (the common prefix is computed on raw characters,
 * so mixed tabs/spaces still de-indent correctly as long as the leading run is consistent — which it
 * is for machine-indented source).
 */
export function dedent(text: string): string {
	// Normalize CRLF so line handling is uniform; the renderer emits LF anyway.
	const lines = text.replace(/\r\n?/g, '\n').split('\n');

	// Drop leading and trailing blank lines (the newline right after the opening backtick, etc.).
	while (lines.length && lines[0]!.trim() === '') lines.shift();
	while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
	if (!lines.length) return '';

	// Common leading-whitespace prefix across NON-blank lines.
	let common: string | null = null;
	for (const line of lines) {
		if (line.trim() === '') continue; // blank lines don't constrain the indent
		const lead = /^[\t ]*/.exec(line)![0];
		if (common === null) {
			common = lead;
		} else {
			// Shrink `common` to the longest shared prefix of the two leads.
			let i = 0;
			const max = Math.min(common.length, lead.length);
			while (i < max && common[i] === lead[i]) i++;
			common = common.slice(0, i);
		}
		if (common === '') break; // nothing shared — nothing to strip
	}

	const n = common?.length ?? 0;
	return lines.map((line) => (line.trim() === '' ? '' : line.slice(n))).join('\n');
}
