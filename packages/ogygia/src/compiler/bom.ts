/**
 * A leading UTF-8 byte-order mark is invisible text. Svelte's `parse` drops it, so every AST offset
 * it reports is one short of the raw source, and a pass that edits the raw source by those offsets
 * (MagicString) lands one character early — splitting a tag name (`<qds-butto data-og-opaquen`, a
 * field build). The compiler therefore takes the mark off at the doors where source comes in (the
 * per-file transform, the barrel rewrite, the file reader), so every pass sees exactly the text its
 * parser saw. Dropping it changes nothing a browser or a bundler reads.
 */
const BOM = 0xfeff;

/** `source` without a leading byte-order mark (the same string when there is none). */
export function strip_bom(source: string): string {
	return source.charCodeAt(0) === BOM ? source.slice(1) : source;
}
