/**
 * The ONE canonical side-channel escape. A devalue/JSON payload emitted inside a `<script>` must not
 * be able to break out of it — escaping `<` neutralizes `</script>`, `<script`, and `<!--`. Every seed
 * / marker serializer (page seed, remote seed, context markers, streamed resolve scripts) routes its
 * payload through here, so the escape lives in exactly one auditable place.
 */
export function escape_script_text(s: string): string {
	return s.replaceAll('<', '\\u003C');
}

/**
 * An attribute value for a double-quoted attribute: `&`, `"`, `<` escaped. One pass; a value with
 * none of them (nearly every href) comes back as itself, no copy.
 */
export function escape_attr(s: string): string {
	// (measured: the native searches settle the clean case with no copy; when there IS something to
	// escape, the engine's replace builds the result faster than a hand-built string does)
	if (s.indexOf('&') === -1 && s.indexOf('"') === -1 && s.indexOf('<') === -1) return s;
	return s.replace(AMP_G, '&amp;').replace(QUOT_G, '&quot;').replace(LT_G, '&lt;');
}

/** `&` only (a URL into an attribute: its query's separators). No copy without one. */
export function escape_amp(s: string): string {
	return s.indexOf('&') === -1 ? s : s.replaceAll('&', '&amp;');
}

/** `&` and `"` only (a value re-emitted into a double-quoted attribute exactly as it was, `<` kept). */
export function escape_amp_quot(s: string): string {
	if (s.indexOf('&') === -1 && s.indexOf('"') === -1) return s;
	return s.replace(AMP_G, '&amp;').replace(QUOT_G, '&quot;');
}

/** Text content: `&`, `<`, `>` escaped. Text with none of them comes back as itself, no copy. */
export function escape_text(s: string): string {
	if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1) return s;
	return s.replace(AMP_G, '&amp;').replace(LT_G, '&lt;').replace(GT_G, '&gt;');
}

const AMP_G = /&/g;
const QUOT_G = /"/g;
const LT_G = /</g;
const GT_G = />/g;
