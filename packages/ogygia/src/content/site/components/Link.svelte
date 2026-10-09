<script lang="ts">
	/**
	 * The dialect's `a` — makes prose links ADDRESSES instead of URLs. A bare href (`regions/held`,
	 * no scheme, no leading `/` `#` `.`) is slug-form: resolved through the site at render, so prose
	 * never hardcodes the mount and survives re-mounting; declared redirect history resolves to the
	 * canonical page. Everything else (absolute, external, anchors, relative assets) passes through
	 * untouched. Outside a `<Shell>` (no context) bare hrefs pass through too — audit still checks them.
	 */
	import type { Snippet } from 'svelte';
	import { get_shell_context } from '../context.js';
	import { href_of } from '../outline.js';

	// ── regexes
	const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

	let {
		href = '',
		children,
		...rest
	}: { href?: string; children?: Snippet } & Record<string, unknown> = $props();

	const ctx = get_shell_context();

	function is_bare(h: string): boolean {
		return !!h && !URL_SCHEME_RE.test(h) && !h.startsWith('/') && !h.startsWith('#') && !h.startsWith('.') && !h.startsWith('//');
	}

	async function resolve(h: string): Promise<string> {
		const [slug, frag] = h.split('#');
		const tail = frag ? `#${frag}` : '';
		const hit = await ctx!.site!.outline.resolve(slug);
		if (hit) return href_of(ctx!.base, hit.record.slug) + tail;
		const canonical = await ctx!.site!.outline.alias(slug);
		if (canonical) return href_of(ctx!.base, canonical) + tail;
		return h; // unknown — leave as-written; the audit is the reporting surface
	}

	// Deliberate init-time snapshot (csr=false SSR): a prose link's target never changes mid-mount.
	// svelte-ignore state_referenced_locally
	const resolved = ctx?.site && is_bare(href) ? await resolve(href) : href;
</script>

<a {...rest} href={resolved}>{@render children?.()}</a>
