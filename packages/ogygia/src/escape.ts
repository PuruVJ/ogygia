/**
 * The ONE canonical side-channel escape. A devalue/JSON payload emitted inside a `<script>` must not
 * be able to break out of it — escaping `<` neutralizes `</script>`, `<script`, and `<!--`. Every seed
 * / marker serializer (page seed, remote seed, context markers, streamed resolve scripts) routes its
 * payload through here, so the escape lives in exactly one auditable place.
 */
export function escape_script_text(s: string): string {
	return s.replaceAll('<', '\\u003C');
}
