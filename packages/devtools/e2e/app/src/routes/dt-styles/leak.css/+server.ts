// A planted unscoped fallback: the comment is the one ogygia's build writes before a component's
// raw style bodies when it cannot compile them scoped (unscoped-css.ts), and the rule under it
// applies page-wide, as such a fallback's rules do.
const CSS = `/*! ogygia-unscoped: LabCard.svelte | Unexpected token */
.row {
	background: #fde68a;
	padding: 4px 8px;
}
`;

export const GET = () => new Response(CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60' } });
